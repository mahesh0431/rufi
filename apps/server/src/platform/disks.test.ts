// Which disk a folder is on, from the list `mount` prints on the Mac (and on
// the CI's Linux): the deepest mount that holds it decides.
import { expect, it } from "vitest";
import { onNetworkDisk } from "./disks.ts";

const MAC = `/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
devfs on /dev (devfs, local, nobrowse)
/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)
map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)
//asha@nas.local/Health on /Volumes/Health (smbfs, nodev, nosuid, mounted by asha)
/dev/disk5s1 on /Volumes/Health Archive (exfat, local, nodev, nosuid, noowners, mounted by asha)
nas.local:/export on /Volumes/Shared (nfs, nodev, nosuid, mounted by asha)
`;

const LINUX = `/dev/root on / type ext4 (rw,relatime,discard,errors=remount-ro)
//nas/health on /mnt/health type cifs (rw,relatime,vers=3.1.1)
`;

it.each([
  ["/Users/asha/Rufi data", false],
  ["/Volumes/Health/Rufi", true],
  ["/Volumes/Health", true],
  // A disk whose name starts with a network disk's is its own disk.
  ["/Volumes/Health Archive/Rufi", false],
  ["/Volumes/Shared/Rufi", true],
])("on the Mac, %s is on a network disk: %s", (path, network) => {
  expect(onNetworkDisk(path, MAC)).toBe(network);
});

it("reads Linux's lines too", () => {
  expect(onNetworkDisk("/mnt/health/Rufi", LINUX)).toBe(true);
  expect(onNetworkDisk("/home/asha/Rufi", LINUX)).toBe(false);
});
