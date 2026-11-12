#!/usr/bin/env python3
"""Proxmox Zentrale – eine VM in einen Container (LXC) umwandeln.

  vm2lxc.py inspect <vmid>          → JSON-Analyse (VM läuft: über den Gast-Agenten, sonst Festplatte nur lesend einhängen)
  vm2lxc.py convert <plan.json>     → Umwandlung (läuft als Aufgabe mit Live-Ausgabe)

Die VM selbst wird nie verändert – ihre Festplatten werden nur lesend eingehängt. Am Ende wird lediglich
„beim Hochfahren starten“ der VM ausgeschaltet, damit VM und Container nicht gleichzeitig laufen.
"""
import contextlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

LOCAL_FS = {"ext4", "ext3", "ext2", "xfs", "btrfs"}
NET_FS = {"cifs", "smb3", "nfs", "nfs4"}
SKIP_TARGETS = {"/", "/boot", "/boot/efi", "/efi", "none", "swap"}
OSTYPES = {"debian": "debian", "ubuntu": "ubuntu", "alpine": "alpine", "centos": "centos", "rocky": "centos",
           "almalinux": "centos", "fedora": "fedora", "arch": "archlinux", "opensuse-leap": "opensuse",
           "opensuse-tumbleweed": "opensuse", "devuan": "devuan"}
UID_SHIFT = 100000
STATE_DIR = os.environ.get("BPUI_STATE_DIR", "/var/lib/better-proxmox-ui")
TAR_EXCLUDES = ["./proc/*", "./sys/*", "./dev/*", "./run/*", "./tmp/*", "./var/tmp/*", "./boot/*", "lost+found",
                "./swapfile", "./swap.img", "./var/cache/apt/archives/*.deb", "./var/lib/docker/overlay2",
                "./var/lib/docker/image", "./var/lib/docker/containers", "./var/lib/docker/buildkit",
                "./var/lib/docker/network", "./var/lib/containerd", "./var/lib/docker/tmp"]


# ----------------------------------------------------------------------------- Hilfen
def sh(cmd, check=False, timeout=None, **kw):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **kw)
    except FileNotFoundError:
        r = subprocess.CompletedProcess(cmd, 127, "", f"{cmd[0]}: nicht installiert")
    except subprocess.TimeoutExpired:
        r = subprocess.CompletedProcess(cmd, 124, "", f"{cmd[0]}: Zeitüberschreitung")
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:3])}: {(r.stderr or r.stdout).strip()[-400:]}")
    return r


def say(msg):
    print(f"\n\033[1;36m━━ {msg} ━━\033[0m", flush=True)


def ok(msg):
    print(f"\033[1;32m✔\033[0m {msg}", flush=True)


def warn(msg):
    print(f"\033[1;33m⚠ {msg}\033[0m", flush=True)


def gb(n):
    return f"{n / 1024**3:.1f} GB"


def vm_config(vmid):
    return json.loads(sh(["pvesh", "get", f"/nodes/{socket.gethostname()}/qemu/{vmid}/config", "--output-format", "json"], check=True).stdout)


def vm_status(vmid):
    return "running" if "running" in sh(["qm", "status", str(vmid)]).stdout else "stopped"


def parse_fstab(text):
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        p = line.split()
        if len(p) >= 3:
            out.append({"source": p[0].replace("\\040", " "), "target": p[1].replace("\\040", " "), "fstype": p[2],
                        "options": p[3] if len(p) > 3 else "defaults"})
    return out


def parse_os_release(text):
    d = {}
    for line in text.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            d[k.strip()] = v.strip().strip('"').strip("'")
    return d


def ostype_for(osr):
    for key in [osr.get("ID", "")] + osr.get("ID_LIKE", "").split():
        if key in OSTYPES:
            return OSTYPES[key]
    return None


def vm_disks(cfg):
    disks = []
    for k, v in cfg.items():
        if re.fullmatch(r"(scsi|virtio|sata|ide)\d+", k) and "media=cdrom" not in v and not v.startswith("none"):
            volid = v.split(",")[0]
            size = re.search(r"size=(\d+(?:\.\d+)?)([KMGT]?)", v)
            mult = {"": 1, "K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4}
            disks.append({"key": k, "volid": volid, "size": int(float(size.group(1)) * mult[size.group(2)]) if size else None})
    return sorted(disks, key=lambda d: d["key"])


def vm_nics(cfg):
    nics = []
    for k, v in sorted(cfg.items()):
        if re.fullmatch(r"net\d+", k):
            opts = dict(x.split("=", 1) for x in v.split(",") if "=" in x)
            mac = next((opts[m] for m in ("virtio", "e1000", "e1000e", "vmxnet3", "rtl8139") if m in opts), None)
            nics.append({"key": k, "mac": mac, "bridge": opts.get("bridge", "vmbr0"), "tag": opts.get("tag"),
                         "firewall": opts.get("firewall") == "1"})
    return nics


def host_gateway():
    r = sh(["ip", "-j", "route", "show", "default"])
    with contextlib.suppress(Exception):
        return json.loads(r.stdout)[0].get("gateway")
    return None


def host_net_mounts():
    out = []
    with contextlib.suppress(OSError):
        for line in open("/proc/self/mounts"):
            p = line.split()
            if len(p) >= 3 and p[2] in NET_FS:
                out.append({"source": p[0].replace("\\040", " "), "target": p[1].replace("\\040", " "), "fstype": p[2]})
    return out


def norm_share(src):
    """//NAS/Fotos/sub → ('nas', ['fotos', 'sub'])   nas:/export/x → ('nas', ['export','x'])"""
    s = src.replace("\\", "/")
    if s.startswith("//"):
        parts = [x for x in s[2:].split("/") if x]
        return (parts[0].lower() if parts else ""), [x.lower() for x in parts[1:]]
    if ":" in s:
        host, path = s.split(":", 1)
        return host.lower(), [x for x in path.split("/") if x]
    return "", []


def match_host_mount(src, host_mounts):
    """Gibt den Pfad auf dem Server zurück, unter dem dieselbe NAS-Freigabe schon eingehängt ist."""
    h, parts = norm_share(src)
    best = None
    for m in host_mounts:
        mh, mparts = norm_share(m["source"])
        if mh == h and parts[:len(mparts)] == mparts and (best is None or len(mparts) > best[0]):
            orig = [x for x in src.replace("\\", "/").lstrip("/").split("/")[1:] if x] if src.startswith("//") \
                else [x for x in src.split(":", 1)[1].split("/") if x]
            best = (len(mparts), os.path.join(m["target"], *orig[len(mparts):]))
    return best[1] if best else None


def find_compose_files(root):
    found = []
    for base in ["root", "home", "opt", "srv", "docker", "data"]:
        b = Path(root) / base
        if not b.is_dir():
            continue
        for depth in range(0, 4):
            for name in ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"):
                for f in b.glob("/".join(["*"] * depth + [name])):
                    rel = "/" + str(f.relative_to(root))
                    if "/." not in rel and "/node_modules/" not in rel:
                        found.append(rel)
    return sorted(set(found))


# ----------------------------------------------------------------------------- Festplatten lesend einhängen
class DiskMounter:
    def __init__(self, vmid, cfg):
        self.vmid, self.cfg = vmid, cfg
        self.loops, self.nbds, self.vgs, self.mounts = [], [], [], []
        self.base = tempfile.mkdtemp(prefix=f"bpui-vm{vmid}-")
        self.root = None

    def attach(self):
        host_vgs = set(sh(["vgs", "--noheadings", "-o", "vg_name"]).stdout.split())
        for d in vm_disks(self.cfg):
            r = sh(["pvesm", "path", d["volid"]])
            path = r.stdout.strip()
            if r.returncode != 0 or not path:
                raise RuntimeError(f"Pfad von {d['volid']} unbekannt: {r.stderr.strip()}")
            if path.startswith("rbd:") or "://" in path:
                raise RuntimeError(f"{d['volid']} liegt auf Ceph/Netzwerk – das wird (noch) nicht unterstützt.")
            if path.startswith("/dev/") and not os.path.exists(path):
                sh(["lvchange", "-ay", path.replace("/dev/", "", 1)])
            fmt = "raw"
            if not path.startswith("/dev/"):
                with contextlib.suppress(Exception):
                    fmt = json.loads(sh(["qemu-img", "info", "--output", "json", path]).stdout)["format"]
            if fmt == "raw":
                dev = sh(["losetup", "-r", "-P", "-f", "--show", path], check=True).stdout.strip()
                self.loops.append(dev)
            else:
                sh(["modprobe", "nbd", "max_part=16"])
                dev = next((f"/dev/nbd{i}" for i in range(16) if Path(f"/sys/block/nbd{i}/size").read_text().strip() == "0"), None)
                if not dev:
                    raise RuntimeError("Kein freies NBD-Gerät gefunden.")
                sh(["qemu-nbd", "-r", "-f", fmt, "-c", dev, path], check=True)
                self.nbds.append(dev)
                time.sleep(1)
            sh(["partprobe", dev])
        time.sleep(1)
        # LVM in der VM (z. B. Ubuntu „ubuntu-vg“) aktivieren
        devs = self.loops + self.nbds
        r = sh(["pvs", "--noheadings", "-o", "pv_name,vg_name", "--devices", ",".join(self._all_parts(devs))] if devs else ["true"])
        for line in r.stdout.splitlines():
            p = line.split()
            if len(p) == 2:
                vg = p[1]
                if vg in host_vgs:
                    raise RuntimeError(f"Die VM nutzt eine LVM-Gruppe „{vg}“, die es auf dem Server schon gibt – das kann nicht sicher eingehängt werden.")
                if vg not in self.vgs:
                    sh(["vgchange", "-ay", vg], check=True)
                    self.vgs.append(vg)
        time.sleep(1)

    def _all_parts(self, devs):
        out = []
        for d in devs:
            out.append(d)
            name = os.path.basename(d)
            for p in sorted(Path(f"/sys/block/{name}").glob(f"{name}p*")):
                out.append("/dev/" + p.name)
        return out

    def filesystems(self):
        """Alle Dateisysteme auf den VM-Festplatten (inkl. LVM in der VM)."""
        out = []
        devs = self._all_parts(self.loops + self.nbds)
        for vg in self.vgs:
            for lv in sh(["lvs", "--noheadings", "-o", "lv_path", vg]).stdout.split():
                devs.append(lv)
        for dev in devs:
            info = sh(["blkid", "-o", "export", dev]).stdout
            d = dict(line.split("=", 1) for line in info.splitlines() if "=" in line)
            if d.get("TYPE") == "crypto_LUKS":
                raise RuntimeError("Die VM-Festplatte ist verschlüsselt (LUKS) – das kann nicht automatisch umgewandelt werden.")
            if d.get("TYPE") in LOCAL_FS | {"vfat"}:
                out.append({"dev": dev, "type": d["TYPE"], "uuid": d.get("UUID"), "label": d.get("LABEL"), "partuuid": d.get("PARTUUID")})
        return out

    def mount(self, dev, fstype, target, subvol=None):
        opts = {"ext4": "ro,noload", "ext3": "ro,noload", "xfs": "ro,norecovery,nouuid", "btrfs": "ro"}.get(fstype, "ro")
        if subvol:
            opts += f",subvol={subvol}"
        os.makedirs(target, exist_ok=True)
        r = sh(["mount", "-t", fstype, "-o", opts, dev, target])
        if r.returncode != 0:
            return False
        self.mounts.append(target)
        return True

    def find_root(self, fss):
        for i, fs in enumerate(f for f in fss if f["type"] in LOCAL_FS):
            t = os.path.join(self.base, f"probe{i}")
            if not self.mount(fs["dev"], fs["type"], t):
                continue
            if fs["type"] == "btrfs" and not os.path.exists(f"{t}/etc/fstab"):
                for sub in ("@", "@root", "root"):
                    if os.path.exists(f"{t}/{sub}/etc/fstab"):
                        self.umount(t)
                        self.mount(fs["dev"], "btrfs", t, sub)
                        break
            if os.path.exists(f"{t}/etc/fstab") and os.path.exists(f"{t}/etc/os-release"):
                self.root = t
                return fs
            self.umount(t)
        raise RuntimeError("Das System der VM wurde auf ihren Festplatten nicht gefunden.")

    def resolve(self, source, fss):
        for fs in fss:
            if source in (fs["dev"], f"UUID={fs['uuid']}", f"LABEL={fs['label']}", f"PARTUUID={fs['partuuid']}",
                          f"/dev/disk/by-uuid/{fs['uuid']}", f"/dev/disk/by-label/{fs['label']}"):
                return fs
        m = re.fullmatch(r"/dev/(?:mapper/)?([\w.+-]+?)(?:-|/)([\w.+-]+)", source)
        if m:  # /dev/mapper/ubuntu--vg-ubuntu--lv oder /dev/ubuntu-vg/ubuntu-lv
            for fs in fss:
                if fs["dev"].replace("--", "-").endswith(source.split("/")[-1].replace("--", "-")):
                    return fs
        return None

    def mount_fstab(self, entries, fss, only_targets=None):
        """Hängt die weiteren lokalen Laufwerke aus der fstab der VM unter dem Wurzelverzeichnis ein."""
        done = []
        for e in sorted(entries, key=lambda e: e["target"].count("/")):
            if e["fstype"] not in LOCAL_FS or e["target"] in SKIP_TARGETS:
                continue
            if only_targets is not None and e["target"] not in only_targets:
                continue
            fs = self.resolve(e["source"], fss)
            if not fs:
                warn(f"Laufwerk für {e['target']} ({e['source']}) nicht gefunden – wird übersprungen.")
                continue
            sub = re.search(r"subvol=([^,]+)", e["options"])
            if self.mount(fs["dev"], fs["type"], self.root + e["target"], sub.group(1).lstrip("/") if sub else None):
                done.append(e["target"])
        return done

    def umount(self, t):
        sh(["umount", t])
        if t in self.mounts:
            self.mounts.remove(t)

    def cleanup(self):
        for t in reversed(list(self.mounts)):
            if sh(["umount", t]).returncode != 0:
                sh(["umount", "-l", t])
        self.mounts.clear()
        for vg in self.vgs:
            sh(["vgchange", "-an", vg])
        for d in self.nbds:
            sh(["qemu-nbd", "-d", d])
        for d in self.loops:
            sh(["losetup", "-d", d])
        self.vgs, self.nbds, self.loops = [], [], []
        shutil.rmtree(self.base, ignore_errors=True)


# ----------------------------------------------------------------------------- Analyse
def agent_exec(vmid, *cmd, timeout=60):
    r = sh(["qm", "guest", "exec", str(vmid), "--timeout", str(timeout), "--", *cmd], timeout=timeout + 10)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "Gast-Agent antwortet nicht")
    d = json.loads(r.stdout or "{}")
    return d.get("out-data", ""), d.get("exitcode", 1)


def inspect(vmid):
    cfg = vm_config(vmid)
    status = vm_status(vmid)
    lo = leftovers(vmid)
    res = {"vmid": int(vmid), "name": cfg.get("name") or f"vm{vmid}", "status": status, "mode": None,
           "cores": int(cfg.get("cores", 1)) * int(cfg.get("sockets", 1)), "memory": int(cfg.get("memory", 2048)),
           "onboot": str(cfg.get("onboot", "0")) == "1", "tags": cfg.get("tags", ""), "nics": vm_nics(cfg), "disks": vm_disks(cfg),
           "os": {}, "ostype": None, "mounts": [], "root": None, "compose": [], "docker": False, "snap_docker": False,
           "ips": {}, "gateway": host_gateway(), "warnings": [], "blockers": [], "immich": False,
           "dri": os.path.exists("/dev/dri/renderD128"), "host_mounts": host_net_mounts(),
           "leftovers": lo if has_leftovers(lo) else None}
    if res["leftovers"]:
        res["blockers"].append("Von einer früheren, abgebrochenen Umwandlung sind noch Reste da. Bitte zuerst aufräumen.")
        return res
    if cfg.get("ostype", "l26") not in ("l26", "l24", "other"):
        res["blockers"].append("Das ist keine Linux-VM – nur Linux lässt sich in einen Container umwandeln.")
        return res
    for k in cfg:
        if k.startswith("hostpci"):
            res["warnings"].append("Die VM hat ein durchgereichtes PCI-Gerät (z. B. Grafikkarte) – das wird nicht übernommen.")
        if k.startswith("usb"):
            res["warnings"].append("Die VM hat ein durchgereichtes USB-Gerät – das wird nicht übernommen.")

    fstab_text = osr_text = ""
    used = {}
    if status == "running":
        res["mode"] = "agent"
        try:
            osr_text, _ = agent_exec(vmid, "cat", "/etc/os-release")
            fstab_text, _ = agent_exec(vmid, "cat", "/etc/fstab")
            out, _ = agent_exec(vmid, "findmnt", "-J", "-b", "-l", "-o", "TARGET,SOURCE,FSTYPE,SIZE,USED")
            for fs in json.loads(out or "{}").get("filesystems", []):
                used[fs["target"]] = {"size": fs.get("size"), "used": fs.get("used"), "fstype": fs.get("fstype"), "source": fs.get("source")}
            out, _ = agent_exec(vmid, "sh", "-c", "command -v docker; readlink -f \"$(command -v docker)\" 2>/dev/null; "
                                "docker compose ls -a --format json 2>/dev/null; echo; docker ps -a --format '{{.Image}}' 2>/dev/null")
            lines = out.splitlines()
            res["docker"] = bool(lines and lines[0].strip())
            res["snap_docker"] = any("/snap/" in x for x in lines[:2])
            for line in lines:
                if line.startswith("["):
                    with contextlib.suppress(Exception):
                        for p in json.loads(line):
                            res["compose"] += [f.strip() for f in p.get("ConfigFiles", "").split(",") if f.strip()]
                if "immich" in line.lower():
                    res["immich"] = True
            out, _ = agent_exec(vmid, "ip", "-j", "addr")
            for ifc in json.loads(out or "[]"):
                mac = (ifc.get("address") or "").upper()
                for a in ifc.get("addr_info", []):
                    if a.get("family") == "inet" and not a["local"].startswith(("127.", "172.17.", "172.18.", "172.19.", "172.2")):
                        res["ips"].setdefault(mac, f"{a['local']}/{a['prefixlen']}")
        except Exception as e:  # noqa: BLE001
            res["blockers"].append(f"Die VM läuft, aber der QEMU-Gast-Agent antwortet nicht ({e}). "
                                   "Entweder den Agenten in der VM einrichten – oder die VM herunterfahren, dann wird ihre Festplatte direkt gelesen.")
            return res
    else:
        res["mode"] = "disk"
        dm = DiskMounter(vmid, cfg)
        try:
            dm.attach()
            fss = dm.filesystems()
            rootfs = dm.find_root(fss)
            osr_text = Path(dm.root, "etc/os-release").read_text(errors="replace")
            fstab_text = Path(dm.root, "etc/fstab").read_text(errors="replace")
            st = os.statvfs(dm.root)
            used["/"] = {"size": st.f_blocks * st.f_frsize, "used": (st.f_blocks - st.f_bfree) * st.f_frsize, "fstype": rootfs["type"]}
            entries = parse_fstab(fstab_text)
            for t in dm.mount_fstab(entries, fss):
                st = os.statvfs(dm.root + t)
                used[t] = {"size": st.f_blocks * st.f_frsize, "used": (st.f_blocks - st.f_bfree) * st.f_frsize}
            res["compose"] = find_compose_files(dm.root)
            res["docker"] = os.path.exists(f"{dm.root}/usr/bin/docker") or os.path.exists(f"{dm.root}/snap/bin/docker")
            res["snap_docker"] = os.path.exists(f"{dm.root}/snap/bin/docker") and not os.path.exists(f"{dm.root}/usr/bin/docker")
            for f in res["compose"]:
                with contextlib.suppress(OSError):
                    if "immich" in Path(dm.root + f).read_text(errors="replace").lower():
                        res["immich"] = True
        except Exception as e:  # noqa: BLE001
            res["blockers"].append(str(e))
            return res
        finally:
            dm.cleanup()

    osr = parse_os_release(osr_text)
    res["os"] = {"id": osr.get("ID"), "version": osr.get("VERSION_ID"), "name": osr.get("PRETTY_NAME")}
    res["ostype"] = ostype_for(osr)
    if not res["ostype"]:
        res["blockers"].append(f"Das System „{osr.get('PRETTY_NAME', '?')}“ kann Proxmox nicht als Container einrichten.")
    if any("immich" in c.lower() for c in res["compose"]):
        res["immich"] = True
    root_used = (used.get("/") or {}).get("used") or 0
    res["root"] = {"used": root_used, "fstype": (used.get("/") or {}).get("fstype")}
    for e in parse_fstab(fstab_text):
        if e["target"] in SKIP_TARGETS or e["fstype"] in ("swap", "tmpfs", "proc", "vfat"):
            continue
        if e["fstype"] in NET_FS:
            cred = re.search(r"credentials=([^,]+)", e["options"])
            res["mounts"].append({"target": e["target"], "kind": "nas", "fstype": e["fstype"], "source": e["source"],
                                  "options": re.sub(r"(password|pass)=[^,]*", r"\1=***", e["options"]),
                                  "has_password": bool(cred) or bool(re.search(r"(^|,)pass(word)?=", e["options"])),
                                  "host_path": match_host_mount(e["source"], res["host_mounts"])})
            hp = res["mounts"][-1]["host_path"]
            with contextlib.suppress(OSError):
                res["mounts"][-1]["host_owner_root"] = bool(hp) and os.stat(hp).st_uid < UID_SHIFT
        elif e["fstype"] in LOCAL_FS:
            u = used.get(e["target"]) or {}
            res["mounts"].append({"target": e["target"], "kind": "disk", "fstype": e["fstype"], "source": e["source"],
                                  "used": u.get("used"), "size": u.get("size")})
        else:
            res["warnings"].append(f"{e['target']} ({e['fstype']}) wird nicht übernommen.")
    if res["snap_docker"]:
        res["warnings"].append("Docker ist als Snap installiert – Snaps laufen in Containern nicht. Docker muss danach aus den normalen Paketquellen neu installiert werden.")
    if res["docker"]:
        res["warnings"].append("Docker-Images werden nicht mitkopiert, sondern nach dem Umzug neu geladen (die Daten bleiben erhalten). Das braucht Internet und ein paar Minuten.")
    return res


# ----------------------------------------------------------------------------- Umwandeln
def shift_chown(path):
    with contextlib.suppress(OSError):
        os.chown(path, UID_SHIFT, UID_SHIFT)


def nas_host_mount(item, guest_root, ctid):
    """Hängt eine NAS-Freigabe aus der fstab der VM auf dem Server ein (für den Container mit verschobenen IDs)."""
    slug = re.sub(r"[^a-z0-9]+", "-", (item["source"].split("/")[-1] or item["target"].split("/")[-1]).lower()).strip("-") or "nas"
    target = f"/mnt/bpui/{slug}"
    n = 2
    while os.path.ismount(target) or (os.path.exists(target) and os.listdir(target)):
        target, n = f"/mnt/bpui/{slug}-{n}", n + 1
    os.makedirs(target, exist_ok=True)
    opts = [o for o in item["options_raw"].split(",") if o and not o.startswith(("x-systemd", "noauto", "user"))]
    if item["fstype"] in ("cifs", "smb3"):
        # Zugangsdaten direkt in den Optionen → in eine geschützte Datei verschieben (/etc/fstab ist für alle lesbar)
        inline = {o.split("=", 1)[0]: o.split("=", 1)[1] for o in opts if o.startswith(("username=", "user=", "password=", "pass=", "domain="))}
        if any(k in inline for k in ("password", "pass")):
            dst = Path(f"/etc/better-proxmox-ui/credentials/{slug}-ct{ctid}")
            dst.parent.mkdir(parents=True, exist_ok=True)
            os.chmod(dst.parent, 0o700)
            dst.write_text("".join(f"{'username' if k == 'user' else 'password' if k == 'pass' else k}={v}\n" for k, v in inline.items()))
            os.chmod(dst, 0o600)
            opts = [o for o in opts if o.split("=", 1)[0] not in inline] + [f"credentials={dst}"]
        new = []
        for o in opts:
            k, _, v = o.partition("=")
            if k == "credentials" and v:
                src = Path(guest_root + v)
                if src.is_file():
                    dst = Path(f"/etc/better-proxmox-ui/credentials/{slug}-ct{ctid}")
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    os.chmod(dst.parent, 0o700)
                    dst.write_text(src.read_text())
                    os.chmod(dst, 0o600)
                    o = f"credentials={dst}"
                else:
                    warn(f"Zugangsdatei {v} nicht gefunden – {item['target']} wird ohne Anmeldung versucht.")
                    continue
            elif k in ("uid", "gid", "forceuid", "forcegid"):
                if k in ("uid", "gid"):
                    num = v if v.isdigit() else ("0" if v in ("root", "") else None)
                    if num is None:  # Name → in der VM nachschlagen
                        f = "passwd" if k == "uid" else "group"
                        with contextlib.suppress(OSError):
                            for line in Path(guest_root, "etc", f).read_text().splitlines():
                                p = line.split(":")
                                if p[0] == v:
                                    num = p[2]
                    o = f"{k}={int(num or 0) + UID_SHIFT}"
            new.append(o)
        if not any(o.startswith("uid=") for o in new):
            new.append(f"uid={UID_SHIFT}")
        if not any(o.startswith("gid=") for o in new):
            new.append(f"gid={UID_SHIFT}")
        opts = new
    opts += ["_netdev", "nofail"]
    line = f"{item['source'].replace(' ', chr(92) + '040')} {target} {item['fstype']} {','.join(dict.fromkeys(opts))} 0 0"
    with open("/etc/fstab", "a") as fh:
        fh.write(f"\n# Proxmox Zentrale: NAS-Freigabe für Container {ctid} ({item['target']})\n{line}\n")
    sh(["systemctl", "daemon-reload"])
    r = sh(["mount", target], timeout=60)
    if r.returncode == 0:
        ok(f"{item['source']} auf dem Server unter {target} eingehängt")
    else:
        warn(f"{item['source']} ließ sich auf dem Server nicht einhängen ({r.stderr.strip()[-200:]}). "
             f"Eintrag steht in /etc/fstab – bitte unter „Speicher & NAS“ prüfen.")
    return target


def fix_guest_files(ctroot, plan, ostype):
    """Passt das kopierte System an den Container an (vor dem ersten Start)."""
    fstab = Path(ctroot, "etc/fstab")
    if fstab.exists():
        lines = fstab.read_text(errors="replace").splitlines()
        out = ["# Von Proxmox Zentrale beim Umwandeln in einen Container auskommentiert.",
               "# Laufwerke und NAS-Freigaben bindet jetzt Proxmox ein (Container-Einstellungen → Laufwerke)."]
        out += [ln if (not ln.strip() or ln.lstrip().startswith("#")) else "#VM# " + ln for ln in lines]
        fstab.write_text("\n".join(out) + "\n")
    if Path(ctroot, "etc/cloud").is_dir():
        Path(ctroot, "etc/cloud/cloud-init.disabled").touch()
        shift_chown(str(Path(ctroot, "etc/cloud/cloud-init.disabled")))
    for unit in ("qemu-guest-agent", "multipathd", "open-vm-tools", "systemd-timesyncd", "chrony", "irqbalance",
                 "smartmontools", "lvm2-monitor", "fwupd-refresh", "thermald", "snapd"):
        for wants in Path(ctroot, "etc/systemd/system").glob("*.wants"):
            p = wants / f"{unit}.service"
            if p.is_symlink():
                p.unlink()
    # Alte Netzwerk-Einstellungen der VM (ens18 …) aus dem Weg räumen – Proxmox schreibt eth0 selbst
    np = Path(ctroot, "etc/netplan")
    if np.is_dir():
        for f in np.glob("*.yaml"):
            f.rename(f.with_suffix(".yaml.vm-backup"))
    ifs = Path(ctroot, "etc/network/interfaces")
    if ifs.exists() and re.search(r"\b(ens|enp|eno)\d", ifs.read_text(errors="replace")):
        ifs.rename(ifs.with_suffix(".vm-backup"))
        ifs.write_text("auto lo\niface lo inet loopback\n")
        shift_chown(str(ifs))


# ----------------------------------------------------------------------------- Reste einer abgebrochenen Umwandlung
class Aborted(Exception):
    pass


def _on_signal(signum, _frame):
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise Aborted("Abgebrochen.")


def _vm_disk_paths(vmid):
    paths = []
    with contextlib.suppress(Exception):
        for d in vm_disks(vm_config(vmid)):
            r = sh(["pvesm", "path", d["volid"]])
            if r.returncode == 0 and r.stdout.strip():
                paths.append(os.path.realpath(r.stdout.strip()))
    return paths


def _plan_ctid(vmid):
    with contextlib.suppress(Exception):
        return str(json.loads(Path(f"{STATE_DIR}/convert-{vmid}.json").read_text())["ctid"])
    return None


def _partial_ct(vmid, ctid):
    """Container aus einer abgebrochenen Umwandlung dieser VM (nur dann wird er angefasst)."""
    if not ctid:
        return None
    conf = Path(f"/etc/pve/lxc/{ctid}.conf")
    if not conf.exists():
        return None
    text = conf.read_text(errors="replace")
    locked = bool(re.search(r"^lock:\s*create", text, re.M))
    # Nummer stammt aus unserem Plan und war beim Start frei → mit Sperre „create“ oder unserer Beschreibung ist er von uns
    if not locked and f"Aus VM {vmid} " not in text.replace("%20", " "):
        return None
    return {"ctid": ctid, "locked_create": locked,
            "running": "running" in sh(["pct", "status", ctid]).stdout}


def leftovers(vmid):
    vmid = str(vmid)
    res = {"processes": [], "mounts": [], "loops": [], "nbds": [], "ct": None}
    me = os.getpid()
    for pid in sh(["pgrep", "-f", f"vm2lxc.py convert .*convert-{vmid}.json"]).stdout.split():
        if pid.isdigit() and int(pid) != me:
            res["processes"].append(int(pid))
    with contextlib.suppress(OSError):
        for line in open("/proc/self/mounts"):
            t = line.split()[1].replace("\\040", " ")
            if f"/bpui-vm{vmid}-" in t:
                res["mounts"].append(t)
    paths = set(_vm_disk_paths(vmid))
    with contextlib.suppress(Exception):
        for dev in json.loads(sh(["losetup", "-J"]).stdout or "{}").get("loopdevices", []):
            if dev.get("back-file") and os.path.realpath(dev["back-file"].replace(" (deleted)", "")) in paths:
                res["loops"].append(dev["name"])
    for pidf in Path("/sys/block").glob("nbd*/pid"):
        with contextlib.suppress(Exception):
            cmd = Path(f"/proc/{pidf.read_text().strip()}/cmdline").read_bytes().decode(errors="replace")
            if any(p in cmd for p in paths):
                res["nbds"].append("/dev/" + pidf.parent.name)
    res["ct"] = _partial_ct(vmid, _plan_ctid(vmid))
    return res


def has_leftovers(lo):
    return any(lo[k] for k in ("processes", "mounts", "loops", "nbds")) or bool(lo["ct"] and (lo["ct"]["locked_create"]))


def cleanup(vmid, start_vm=True, destroy_ct=True):
    vmid = str(vmid)
    say("Reste der abgebrochenen Umwandlung aufräumen")
    lo = leftovers(vmid)
    for pid in lo["processes"]:
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, signal.SIGTERM)
        for _ in range(30):
            if not Path(f"/proc/{pid}").exists():
                break
            time.sleep(1)
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, signal.SIGKILL)
        ok(f"Hängende Umwandlung (Prozess {pid}) beendet")
    for p in ("tar -C /tmp/bpui-vm" + vmid, f"pct create {lo['ct']['ctid']} -" if lo["ct"] else None):
        if p:
            sh(["pkill", "-9", "-f", p])
    time.sleep(1)
    lo = leftovers(vmid)
    for t in sorted(lo["mounts"], key=len, reverse=True):
        if sh(["umount", t]).returncode != 0:
            sh(["umount", "-l", t])
    for base in Path("/tmp").glob(f"bpui-vm{vmid}-*"):
        shutil.rmtree(base, ignore_errors=True)
    if lo["mounts"]:
        ok(f"{len(lo['mounts'])} Einhängepunkt(e) gelöst")
    host_vgs = set()
    devs = []
    for d in lo["loops"] + lo["nbds"]:
        name = os.path.basename(d)
        devs += [d] + ["/dev/" + x.name for x in Path(f"/sys/block/{name}").glob(f"{name}p*")]
    if devs:
        for line in sh(["pvs", "--noheadings", "-o", "vg_name", "--devices", ",".join(devs)]).stdout.split():
            host_vgs.add(line)
        for vg in host_vgs:
            sh(["vgchange", "-an", vg])
    for d in lo["nbds"]:
        sh(["qemu-nbd", "-d", d])
    for d in lo["loops"]:
        sh(["losetup", "-d", d])
    if lo["loops"] or lo["nbds"]:
        ok("VM-Festplatten wieder freigegeben")
    ct = lo["ct"]
    if ct and destroy_ct:
        cid = ct["ctid"]
        sh(["pct", "stop", cid])
        sh(["pct", "unlock", cid])
        r = sh(["pct", "destroy", cid, "--purge"])
        if r.returncode == 0:
            ok(f"Halb fertigen Container {cid} gelöscht")
        else:
            warn(f"Container {cid} ließ sich nicht löschen: {r.stderr.strip()[-200:]}")
        free_orphan_volumes(cid)
    if start_vm and vm_status(vmid) != "running":
        print("Die VM wird wieder gestartet …", flush=True)
        r = sh(["qm", "start", vmid])
        (ok if r.returncode == 0 else warn)("VM läuft wieder" if r.returncode == 0 else f"VM startet nicht: {r.stderr.strip()[-200:]}")
    print("\n\033[1;32m✔ Aufgeräumt.\033[0m Du kannst die Umwandlung jetzt erneut starten.", flush=True)
    return 0


def free_orphan_volumes(ctid):
    """Laufwerke eines abgebrochenen „pct create“, zu denen es keinen Container mehr gibt."""
    if Path(f"/etc/pve/lxc/{ctid}.conf").exists() or Path(f"/etc/pve/qemu-server/{ctid}.conf").exists():
        return
    for line in sh(["pvesm", "status", "--content", "rootdir"]).stdout.splitlines()[1:]:
        store = line.split()[0] if line.split() else None
        if not store:
            continue
        for vline in sh(["pvesm", "list", store, "--vmid", str(ctid), "--content", "rootdir"]).stdout.splitlines()[1:]:
            volid = vline.split()[0] if vline.split() else ""
            # nur Container-Laufwerke (vm-/subvol-<id>-disk-N), niemals Sicherungen o. Ä.
            if not re.fullmatch(rf"[\w.-]+:(?:[\w.-]+/)?(?:vm|subvol)-{ctid}-disk-\d+(?:\.raw)?", volid):
                continue
            if sh(["pvesm", "free", volid]).returncode == 0:
                ok(f"Übrig gebliebenes Laufwerk {volid} gelöscht")


# ----------------------------------------------------------------------------- Kopieren
STALL_LIMIT = 15 * 60   # so lange darf nichts vorangehen, dann wird abgebrochen
CHILDREN: list[subprocess.Popen] = []


def _drain(stream, sink, prefix):
    """Liest eine Ausgabe laufend mit – sonst läuft ihr Puffer voll und alles bleibt stehen."""
    for raw in iter(stream.readline, b""):
        line = raw.decode(errors="replace").rstrip()
        if not line:
            continue
        sink.append(line)
        if len(sink) > 400:
            del sink[:200]
        sink_count = sink_counts.setdefault(prefix, [0])
        sink_count[0] += 1
        if sink_count[0] <= 15:
            print(f"\r\033[K  {prefix}: {line[:200]}", flush=True)
        elif sink_count[0] == 16:
            print(f"\r\033[K  {prefix}: … weitere Meldungen werden nur noch gezählt", flush=True)


sink_counts: dict[str, list[int]] = {}


def copy_into_container(root, excludes, create_args, total):
    """tar (liest die VM) → pct create (schreibt den Container) – mit Fortschritt, ohne Zwischenarchiv."""
    import threading
    tar = subprocess.Popen(["tar", "-C", root, "--numeric-owner", "--xattrs", "--xattrs-include=user.*",
                            "--xattrs-include=security.capability", "--acls", "--sparse",
                            "--warning=no-file-ignored", "--warning=no-file-changed",
                            *[f"--exclude={e}" for e in excludes], "-cpf", "-", "."],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    pct = subprocess.Popen(create_args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    CHILDREN[:] = [tar, pct]
    tar_err, pct_out = [], []
    threads = [threading.Thread(target=_drain, args=(tar.stderr, tar_err, "lesen"), daemon=True),
               threading.Thread(target=_drain, args=(pct.stdout, pct_out, "schreiben"), daemon=True)]
    for t in threads:
        t.start()
    state = {"copied": 0, "moved": time.time(), "done": False}

    def pump():
        try:
            while True:
                chunk = tar.stdout.read(1024 * 1024)
                if not chunk:
                    break
                pct.stdin.write(chunk)
                state["copied"] += len(chunk)
                state["moved"] = time.time()
        except (BrokenPipeError, ValueError, OSError):
            pass
        finally:
            with contextlib.suppress(Exception):
                pct.stdin.close()
            state["done"] = True

    pt = threading.Thread(target=pump, daemon=True)
    pt.start()
    t0, last_print = time.time(), 0.0
    while not state["done"] or pct.poll() is None:
        time.sleep(1)
        now = time.time()
        if pct.poll() is not None and not state["done"]:
            tar.kill()            # pct ist fertig/abgestürzt → Lesen beenden
        if now - state["moved"] > STALL_LIMIT and pct.poll() is None:
            tar.kill()
            pct.kill()
            pct.wait()
            raise RuntimeError(f"Seit {STALL_LIMIT // 60} Minuten geht nichts mehr voran – abgebrochen. "
                               "Letzte Meldungen siehe oben.")
        if now - last_print >= 5:
            last_print = now
            c = state["copied"]
            rate = c / max(1, now - t0)
            line = f"  kopiert: {gb(c)}"
            if total:
                line += f" von ca. {gb(total)} ({min(99, int(c * 100 / total))} %)"
            line += f" · {rate / 1024**2:.0f} MB/s"
            if total and rate > 0 and c < total:
                line += f" · noch ca. {fmt_dur((total - c) / rate)}"
            if state["done"]:
                line = f"  alles gelesen ({gb(c)}) – Container wird fertig angelegt …"
            print(f"\r\033[K{line}", end="", flush=True)
    # Ist „pct create“ vorzeitig beendet, liest niemand mehr – tar sonst ewig blockiert
    if tar.poll() is None:
        tar.kill()
    tar.wait()
    for t in threads:
        t.join(timeout=5)
    CHILDREN.clear()
    print(f"\r\033[K  kopiert: {gb(state['copied'])} in {fmt_dur(time.time() - t0)}", flush=True)
    return state["copied"], pct.returncode, tar.returncode, pct_out


def fmt_dur(sec):
    sec = int(sec)
    if sec < 90:
        return f"{sec} s"
    if sec < 5400:
        return f"{sec // 60} min"
    return f"{sec // 3600} h {sec % 3600 // 60} min"


def convert(plan_path):
    plan = json.loads(Path(plan_path).read_text())
    vmid, ctid = str(plan["vmid"]), str(plan["ctid"])
    cfg = vm_config(vmid)
    was_running = vm_status(vmid) == "running"
    dm = DiskMounter(vmid, cfg)
    created = complete = False
    signal.signal(signal.SIGHUP, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)
    try:
        say("1/7  Vorbereitung prüfen")
        if Path(f"/etc/pve/lxc/{ctid}.conf").exists() or Path(f"/etc/pve/qemu-server/{ctid}.conf").exists():
            raise RuntimeError(f"Die Nummer {ctid} ist schon vergeben.")
        ok(f"VM {vmid} „{cfg.get('name', '')}“ → Container {ctid} „{plan['hostname']}“")

        say("2/7  VM herunterfahren")
        if was_running:
            print("Die VM wird sauber heruntergefahren (bis zu 3 Minuten) …", flush=True)
            r = sh(["qm", "shutdown", vmid, "--timeout", "180"], timeout=240)
            if r.returncode != 0 or vm_status(vmid) == "running":
                raise RuntimeError("Die VM ließ sich nicht herunterfahren. Bitte von Hand herunterfahren und erneut versuchen.")
            ok("VM ist aus")
        else:
            ok("VM ist bereits aus")

        say("3/7  Festplatten der VM lesend einhängen")
        dm.attach()
        fss = dm.filesystems()
        rootfs = dm.find_root(fss)
        ok(f"System gefunden auf {rootfs['dev']} ({rootfs['type']})")
        entries = parse_fstab(Path(dm.root, "etc/fstab").read_text(errors="replace"))
        disk_targets = [m["target"] for m in plan.get("mounts", []) if m["kind"] == "disk" and m.get("action") != "skip"]
        for t in dm.mount_fstab(entries, fss, only_targets=set(disk_targets)):
            ok(f"Laufwerk {t} eingehängt")
        osr = parse_os_release(Path(dm.root, "etc/os-release").read_text(errors="replace"))
        ostype = ostype_for(osr) or "unmanaged"
        raw_opts = {e["target"]: e["options"] for e in entries}
        for m in plan.get("mounts", []):
            m["options_raw"] = raw_opts.get(m["target"], "defaults")

        say("4/7  Container anlegen und Daten kopieren")
        storage = plan["storage"]
        # Aus einem Datenstrom („-“) kann Proxmox nur im Wiederherstellungs-Modus anlegen
        args = ["pct", "create", ctid, "-", "--restore", "1", "--hostname", plan["hostname"], "--ostype", ostype,
                "--unprivileged", "1", "--features", "nesting=1,keyctl=1", "--cores", str(plan["cores"]),
                "--memory", str(plan["memory"]), "--swap", str(plan.get("swap", 512)),
                "--rootfs", f"{storage}:{plan['rootfs_gb']}", "--onboot", "1" if plan.get("onboot") else "0",
                "--ignore-unpack-errors", "1",
                "--description", f"Aus VM {vmid} ({cfg.get('name', '')}) umgewandelt am {time.strftime('%d.%m.%Y')} – Proxmox Zentrale"]
        if plan.get("tags"):
            args += ["--tags", plan["tags"]]
        mp_i = 0
        excludes = list(TAR_EXCLUDES)
        for m in plan.get("mounts", []):
            if m["kind"] == "disk":
                if m.get("action") == "skip":
                    excludes.append("." + m["target"] + "/*")
                    continue
                args += [f"--mp{mp_i}", f"{storage}:{m['size_gb']},mp={m['target']},backup=1"]
                mp_i += 1
            elif m["kind"] == "nas":
                excludes.append("." + m["target"] + "/*")
        for i, n in enumerate(plan["nics"]):
            net = f"name=eth{i},bridge={n['bridge']}"
            if n.get("mac"):
                net += f",hwaddr={n['mac']}"
            if n.get("tag"):
                net += f",tag={int(n['tag'])}"
            if n.get("firewall"):
                net += ",firewall=1"
            if n.get("ip") and n["ip"] != "dhcp":
                net += f",ip={n['ip']}" + (f",gw={n['gw']}" if n.get("gw") else "")
            else:
                net += ",ip=dhcp"
            args += [f"--net{i}", net]
        total = sum((m.get("used") or 0) for m in plan.get("mounts", []) if m["kind"] == "disk" and m.get("action") != "skip") \
            + (plan.get("root_used") or 0)
        created = True
        copied, rc_pct, rc_tar, out = copy_into_container(dm.root, excludes, args, total)
        if rc_pct != 0:
            print("\n".join(out[-25:]))
            raise RuntimeError("Der Container konnte nicht angelegt werden (siehe oben).")
        if rc_tar not in (0, 1):
            warn(f"Beim Lesen der VM-Festplatte gab es Fehler (tar {rc_tar}) – Details stehen oben.")
        complete = True
        ok(f"Container {ctid} angelegt, {gb(copied)} kopiert")

        say("5/7  System an den Container anpassen")
        r = sh(["pct", "mount", ctid], check=True)
        ctroot = f"/var/lib/lxc/{ctid}/rootfs"
        try:
            fix_guest_files(ctroot, plan, ostype)
        finally:
            sh(["pct", "unmount", ctid])
        ok("fstab, Netzwerk und VM-Dienste angepasst")
        for m in plan.get("mounts", []):
            if m["kind"] != "nas" or m.get("action") == "skip":
                continue
            host_path = m.get("host_path")
            if m.get("action") == "mount":
                host_path = nas_host_mount(m, dm.root, ctid)
            if host_path:
                sh(["pct", "set", ctid, f"--mp{mp_i}", f"{host_path},mp={m['target']}"], check=True)
                ok(f"NAS {m['source']} → {m['target']} (über {host_path})")
                mp_i += 1
        if plan.get("dri") and os.path.exists("/dev/dri/renderD128"):
            gid = 104
            with contextlib.suppress(OSError):
                for line in Path(dm.root, "etc/group").read_text().splitlines():
                    if line.startswith("render:"):
                        gid = int(line.split(":")[2])
            sh(["pct", "set", ctid, "--dev0", f"/dev/dri/renderD128,gid={gid},mode=0666"], check=True)
            if os.path.exists("/dev/dri/card0"):
                sh(["pct", "set", ctid, "--dev1", "/dev/dri/card0,gid=44,mode=0666"])
            ok("Grafikchip (/dev/dri) durchgereicht")

        say("6/7  VM stilllegen")
        sh(["qm", "set", vmid, "--onboot", "0"])
        desc = (cfg.get("description") or "").rstrip()
        sh(["qm", "set", vmid, "--description", (desc + "\n\n" if desc else "") +
            f"⚠ Am {time.strftime('%d.%m.%Y')} in Container {ctid} umgewandelt (Proxmox Zentrale). Nicht gleichzeitig starten!"])
        ok("VM startet nicht mehr automatisch – sie bleibt als Rückfallebene erhalten")

        say("7/7  Container starten")
        if not plan.get("start", True):
            ok("Fertig – Container wurde nicht gestartet (so eingestellt).")
            return 0
        sh(["pct", "start", ctid], check=True)
        print("Warte auf das Netzwerk …", flush=True)
        for _ in range(45):
            if sh(["pct", "exec", ctid, "--", "sh", "-c", "getent hosts github.com >/dev/null || getent hosts deb.debian.org >/dev/null"]).returncode == 0:
                break
            time.sleep(2)
        # NAS-Ordner: kann der Container dort schreiben? (unprivilegierte Container greifen mit verschobenen IDs zu)
        for m in plan.get("mounts", []):
            if m["kind"] != "nas" or m.get("action") == "skip":
                continue
            t = m["target"]
            r = sh(["pct", "exec", ctid, "--", "sh", "-c", f"ls '{t}' >/dev/null && touch '{t}/.bpui-schreibtest' && rm -f '{t}/.bpui-schreibtest'"], timeout=60)
            if r.returncode == 0:
                ok(f"NAS-Ordner {t}: lesen und schreiben klappt")
            elif m.get("fstype", "").startswith("nfs"):
                warn(f"NAS-Ordner {t}: kein Zugriff. Bei NFS sieht die NAS den Container als Benutzer 100000 statt root. "
                     "Abhilfe auf der NAS: in der NFS-Freigabe „Squash: Alle Benutzer zu admin zuordnen“ (Synology) bzw. all_squash mit passender anonuid.")
            else:
                warn(f"NAS-Ordner {t}: kein Zugriff ({(r.stderr or r.stdout).strip()[-160:]}). Rechte der Freigabe prüfen.")
        compose = plan.get("compose") or []
        if compose:
            print("Warte auf Docker …", flush=True)
            for _ in range(30):
                if sh(["pct", "exec", ctid, "--", "docker", "info"]).returncode == 0:
                    break
                time.sleep(2)
            else:
                warn("Docker startet im Container nicht:")
                print(sh(["pct", "exec", ctid, "--", "journalctl", "-u", "docker", "-n", "15", "--no-pager"]).stdout)
            for f in compose:
                print(f"\n\033[1;34m$ docker compose -f {f} up -d\033[0m  (lädt die Images neu – kann dauern)", flush=True)
                rc = subprocess.call(["pct", "exec", ctid, "--", "docker", "compose", "-f", f, "up", "-d"])
                (ok if rc == 0 else warn)(f"{f}: {'läuft' if rc == 0 else 'Fehler – bitte im Container prüfen'}")
        ip = [x for x in sh(["pct", "exec", ctid, "--", "hostname", "-I"], timeout=20).stdout.split()
              if not x.startswith(("172.17.", "172.18.", "172.19.", "172.2", "fd", "fe80"))]
        if ip:
            print(f"\nAdresse des Containers: \033[1m{ip[0]}\033[0m", flush=True)
        if plan.get("immich") and ip:
            print(f"Warte, bis Immich antwortet (höchstens 3 Minuten) …", flush=True)
            # wget/curl mit kurzer Zeitgrenze – sonst wartet wget bei halb gestartetem Server sehr lange
            probe = ("for u in /api/server/ping /api/server-info/ping; do "
                     "wget -q -T 5 -t 1 -O- http://127.0.0.1:2283$u >/dev/null 2>&1 && exit 0; "
                     "curl -fs -m 5 http://127.0.0.1:2283$u >/dev/null 2>&1 && exit 0; done; exit 1")
            for i in range(30):
                if sh(["pct", "exec", ctid, "--", "sh", "-c", probe], timeout=30).returncode == 0:
                    ok(f"Immich antwortet: http://{ip[0]}:2283")
                    break
                print(f"\r  noch nicht bereit … ({(i + 1) * 6} s)", end="", flush=True)
                time.sleep(6)
            else:
                print()
                warn(f"Immich antwortet noch nicht – beim ersten Start dauert es oft ein paar Minuten. Später einfach http://{ip[0]}:2283 öffnen.")
                # Hilfe zur Fehlersuche gleich mitliefern
                print("\nStatus der Docker-Container:", flush=True)
                print(sh(["pct", "exec", ctid, "--", "docker", "ps", "-a", "--format", "  {{.Names}}: {{.Status}}"], timeout=30).stdout, flush=True)
                logs = sh(["pct", "exec", ctid, "--", "docker", "logs", "--tail", "30", "immich_server"], timeout=30)
                if logs.stdout or logs.stderr:
                    print("Letzte Meldungen von immich_server:", flush=True)
                    print(((logs.stdout or "") + (logs.stderr or ""))[-4000:], flush=True)
        print(f"\n\033[1;32m✔ Fertig.\033[0m Container {ctid} läuft{(' unter ' + ip[0]) if ip else ''}. "
              f"Die VM {vmid} ist aus und bleibt als Rückfallebene erhalten – wenn alles passt, kannst du sie später löschen.", flush=True)
        return 0
    except (Exception, Aborted) as e:  # noqa: BLE001
        print(f"\n\033[1;31m✘ {e}\033[0m", flush=True)
        # pct create sauber beenden lassen (räumt seine Laufwerke dann selbst auf), tar sofort
        for c in CHILDREN:
            with contextlib.suppress(Exception):
                c.terminate()
        for c in CHILDREN:
            with contextlib.suppress(Exception):
                c.wait(timeout=45)
            with contextlib.suppress(Exception):
                c.kill()
        dm.cleanup()  # erst aushängen, dann aufräumen und die VM wieder starten
        if created and not complete:
            # Mitten im Kopieren abgebrochen → der Container ist unbrauchbar
            if _partial_ct(vmid, ctid):
                sh(["pct", "unlock", ctid])
                if sh(["pct", "destroy", ctid, "--purge"]).returncode == 0:
                    print(f"Der halb fertige Container {ctid} wurde wieder gelöscht.")
            free_orphan_volumes(ctid)
        elif created and Path(f"/etc/pve/lxc/{ctid}.conf").exists():
            sh(["pct", "stop", ctid])
            print(f"Container {ctid} ist angelegt, aber nicht fertig eingerichtet – er bleibt ausgeschaltet zum Nachsehen.")
        if was_running and vm_status(vmid) != "running":
            print("Die VM wird wieder gestartet …", flush=True)
            sh(["qm", "start", vmid])
        return 1
    finally:
        dm.cleanup()


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "inspect" and sys.argv[2].isdigit():
        print(json.dumps(inspect(sys.argv[2])))
        return 0
    if len(sys.argv) == 3 and sys.argv[1] == "convert":
        return convert(sys.argv[2])
    if len(sys.argv) == 4 and sys.argv[1] == "cleanup" and sys.argv[2].isdigit():
        return cleanup(sys.argv[2], start_vm=sys.argv[3] == "1")
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
