/**
 * Minimal ZIP writer using the "store" method. Images are already
 * compressed, so skipping deflate keeps this dependency-free and fast.
 */

const encoder = new TextEncoder();

export function createZip(entries) {
  const prepared = entries.map((entry) => {
    const name = encoder.encode(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    return {
      name,
      data,
      crc: crc32(data),
      date: dosDateTime(entry.lastModified ? new Date(entry.lastModified) : new Date()),
    };
  });

  let localSize = 0;
  let centralSize = 0;
  for (const entry of prepared) {
    localSize += 30 + entry.name.length + entry.data.length;
    centralSize += 46 + entry.name.length;
  }

  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let offset = 0;
  const centralRecords = [];

  for (const entry of prepared) {
    const localOffset = offset;
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0x0800, true); // UTF-8 filenames
    view.setUint16(offset + 8, 0, true); // store
    view.setUint16(offset + 10, entry.date.time, true);
    view.setUint16(offset + 12, entry.date.date, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.data.length, true);
    view.setUint32(offset + 22, entry.data.length, true);
    view.setUint16(offset + 26, entry.name.length, true);
    view.setUint16(offset + 28, 0, true);
    offset += 30;
    output.set(entry.name, offset);
    offset += entry.name.length;
    output.set(entry.data, offset);
    offset += entry.data.length;

    centralRecords.push({ entry, localOffset });
  }

  const centralOffset = offset;
  for (const { entry, localOffset } of centralRecords) {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true); // version made by
    view.setUint16(offset + 6, 20, true); // version needed
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, entry.date.time, true);
    view.setUint16(offset + 14, entry.date.date, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.data.length, true);
    view.setUint32(offset + 24, entry.data.length, true);
    view.setUint16(offset + 28, entry.name.length, true);
    view.setUint16(offset + 30, 0, true); // extra
    view.setUint16(offset + 32, 0, true); // comment
    view.setUint16(offset + 34, 0, true); // disk
    view.setUint16(offset + 36, 0, true); // internal attrs
    view.setUint32(offset + 38, 0, true); // external attrs
    view.setUint32(offset + 42, localOffset, true);
    offset += 46;
    output.set(entry.name, offset);
    offset += entry.name.length;
  }

  const centralLength = offset - centralOffset;
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, centralLength, true);
  view.setUint32(offset + 16, centralOffset, true);
  view.setUint16(offset + 20, 0, true);

  return output;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dateBits = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dateBits };
}

let crcTable = null;

function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[i] = value >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
