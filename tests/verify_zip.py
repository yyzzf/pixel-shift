"""Inspect a ZIP archive and print entry names, CRCs and contents as hex."""
import json
import sys
import zipfile


def main():
    include_hex = len(sys.argv) < 3 or sys.argv[2] != "--summary"
    with zipfile.ZipFile(sys.argv[1]) as archive:
        bad = archive.testzip()
        if bad is not None:
            raise SystemExit(f"CRC failure in {bad}")
        entries = {}
        for info in archive.infolist():
            entries[info.filename] = {
                "size": info.file_size,
                "crc": info.CRC,
                "hex": archive.read(info).hex() if include_hex else None,
            }
        print(json.dumps({"entries": entries, "names": [i.filename for i in archive.infolist()]}))


if __name__ == "__main__":
    main()
