// Minimal original PDF fixture. Offsets are computed from ASCII bytes.
export function textPdf(pages) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids = [];
  for (const lines of pages) {
    const page = objects.length + 1, stream = page + 1; kids.push(`${page} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${stream} 0 R >>`);
    const escape = (s) => s.replace(/[\\()]/g, "\\$&");
    const content = `BT /F1 10 Tf 50 740 Td 14 TL ${lines.map((s, i) => `${i ? "T* " : ""}(${escape(s)}) Tj`).join("\n")} ET`;
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(" ")}] >>`;
  let data = "%PDF-1.4\n"; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(data.length); data += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = data.length;
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) data += `${String(offset).padStart(10, "0")} 00000 n \n`;
  data += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(data);
}
