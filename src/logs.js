// WebDrive MCP — log console/network ber-kapasitas tetap.
// Tanpa batas, halaman yang banyak request/log → memori merayap naik tak berhenti.

export const LOG_CAP = 500

// Array yang membuang entri paling lama begitu melewati LOG_CAP.
// Subclass Array → perilaku identik array biasa (push/slice/length/JSON.stringify).
export class CappedArray extends Array {
  push(...items) {
    for (const item of items) super.push(item)
    if (this.length > LOG_CAP) this.splice(0, this.length - LOG_CAP)
    return this.length
  }
}
