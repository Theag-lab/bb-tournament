/**
 * PDF exports of the scoreboard's rounds and standings, generated in the browser. jsPDF and its
 * table plugin are loaded on first click only, so they never weigh on the scoreboard's own bundle.
 * The standard PDF fonts cover French accents (Latin-1) but not emoji — keep titles emoji-free.
 */

/** A row spanning the whole table (e.g. "Table 1 : Squad A vs Squad B"). */
export interface PdfGroupRow {
  group: string;
}

export type PdfRow = (string | number)[] | PdfGroupRow;

export interface PdfTable {
  heading?: string;
  head: string[];
  rows: PdfRow[];
}

export interface PdfDocument {
  /** Tournament name, printed at the top of every page. */
  tournamentName: string;
  title: string;
  tables: PdfTable[];
  fileName: string;
}

const MARGIN = 14;

export async function exportPdf(spec: PdfDocument): Promise<void> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const generatedAt = new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(spec.tournamentName, MARGIN, 18);
  doc.setFontSize(12);
  doc.text(spec.title, MARGIN, 26);
  let y = 32;

  for (const table of spec.tables) {
    if (table.heading) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text(table.heading, MARGIN, y + 4);
      y += 7;
    }
    const colCount = table.head.length;
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN, top: 16, bottom: 14 },
      head: [table.head],
      body: table.rows.map((row) =>
        Array.isArray(row)
          ? row.map(String)
          : [{ content: row.group, colSpan: colCount, styles: { fontStyle: 'bold', fillColor: [230, 230, 236] } }]
      ),
      theme: 'striped',
      rowPageBreak: 'avoid', // never split a match (two-line cells) across pages
      styles: { font: 'helvetica', fontSize: 9, cellPadding: 1.8 },
      headStyles: { fillColor: [40, 44, 56], textColor: 255 },
    });
    const finalY = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y;
    y = finalY + 8;
  }

  // Footer on every page, once the page count is known.
  const pageCount = doc.getNumberOfPages();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page);
    const height = doc.internal.pageSize.getHeight();
    const width = doc.internal.pageSize.getWidth();
    doc.text(`${spec.tournamentName} — ${spec.title} — généré le ${generatedAt}`, MARGIN, height - 7);
    doc.text(`${page} / ${pageCount}`, width - MARGIN, height - 7, { align: 'right' });
  }

  doc.save(spec.fileName);
}

/** "OSTBOWL d'Automne" + "ronde 3" -> "ostbowl-d-automne-ronde-3.pdf" */
export function pdfFileName(...parts: string[]): string {
  const slug = parts
    .join(' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'export'}.pdf`;
}
