import type { JSX } from 'react';

/** Classic 16-bytes-per-row hex dump; the first `header` bytes are emphasised. */
export function HexDump({ bytes, limit = 160, header = 0 }: { bytes: Uint8Array; limit?: number; header?: number }) {
  // trim trailing zero padding so short pages don't show 4 KiB of zeros
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const shown = Math.min(Math.max(end, 16), limit);
  const rows: JSX.Element[] = [];
  for (let off = 0; off < shown; off += 16) {
    const hex: JSX.Element[] = [];
    let ascii = '';
    for (let i = off; i < off + 16; i++) {
      if (i >= shown) {
        hex.push(<span key={i}>{'   '}</span>);
        continue;
      }
      const b = bytes[i];
      const s = b.toString(16).padStart(2, '0') + ' ';
      hex.push(i < header ? <b key={i}>{s}</b> : b === 0 ? <i key={i}>{s}</i> : <span key={i}>{s}</span>);
      ascii += b >= 32 && b < 127 ? String.fromCharCode(b) : '·';
    }
    rows.push(
      <div key={off}>
        <i>{off.toString(16).padStart(4, '0')} </i> {hex} <i>{ascii}</i>
      </div>,
    );
  }
  return (
    <div className="hex" aria-label="Page bytes">
      {rows}
      <div>
        <i>
          {end > shown ? `… ${end - shown} more used bytes, ` : ''}
          {bytes.length - end} bytes of free space
        </i>
      </div>
    </div>
  );
}

