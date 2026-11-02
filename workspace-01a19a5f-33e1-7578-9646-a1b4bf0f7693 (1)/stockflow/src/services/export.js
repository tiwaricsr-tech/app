'use strict';
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const config = require('../config');
const { round2, toInt } = require('../lib/errors');

const money = (n) => `${config.company.symbol}${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shortDate = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const dateOnly = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '—');

const BRAND = 'FF1D4ED8';
const BRAND_LIGHT = 'FFEFF4FF';
const SLATE = 'FF0F172A';

function styleHeaderRow(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
  });
  row.height = 22;
}

function autoWidth(worksheet, widths) {
  widths.forEach((w, i) => { worksheet.getColumn(i + 1).width = w; });
}

async function workbookToBuffer(wb) {
  return wb.xlsx.writeBuffer();
}

/** ── Excel report ─────────────────────────────────────────────────────── */
async function buildReportXlsx({ title, subtitle, columns, rows, summary = [], sheetName = 'Report' }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'StockFlow';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName.slice(0, 30), { views: [{ state: 'frozen', ySplit: 5 }] });

  ws.mergeCells(1, 1, 1, columns.length);
  const t = ws.getCell(1, 1);
  t.value = config.company.name;
  t.font = { size: 15, bold: true, color: { argb: SLATE } };

  ws.mergeCells(2, 1, 2, columns.length);
  const s = ws.getCell(2, 1);
  s.value = title;
  s.font = { size: 12, bold: true, color: { argb: BRAND } };

  ws.mergeCells(3, 1, 3, columns.length);
  const sub = ws.getCell(3, 1);
  sub.value = subtitle || `Generated ${new Date().toLocaleString('en-IN')}`;
  sub.font = { size: 9, italic: true, color: { argb: 'FF64748B' } };

  ws.addRow([]);
  const header = ws.addRow(columns.map((c) => c.header));
  styleHeaderRow(header);

  rows.forEach((r, idx) => {
    const row = ws.addRow(columns.map((c) => (c.value ? c.value(r) : r[c.key])));
    if (idx % 2 === 1) {
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      });
    }
    columns.forEach((c, ci) => {
      const cell = row.getCell(ci + 1);
      cell.font = { size: 10, color: { argb: SLATE } };
      if (c.numFmt) cell.numFmt = c.numFmt;
      if (c.align) cell.alignment = { horizontal: c.align };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } } };
    });
  });

  if (rows.length === 0) {
    const empty = ws.addRow(['No records for the selected filters.']);
    ws.mergeCells(empty.number, 1, empty.number, Math.max(1, columns.length));
    empty.font = { italic: true, color: { argb: 'FF64748B' } };
  }

  if (summary.length) {
    ws.addRow([]);
    const head = ws.addRow(['Summary']);
    head.font = { bold: true, size: 11, color: { argb: SLATE } };
    summary.forEach(([label, value]) => {
      const r = ws.addRow([label, value]);
      r.getCell(1).font = { bold: true, size: 10 };
      r.getCell(2).font = { size: 10 };
    });
  }

  autoWidth(ws, columns.map((c) => c.width || 18));
  return workbookToBuffer(wb);
}

/** ── PDF report (landscape A4 table) ──────────────────────────────────── */
function buildReportPdf({ title, subtitle, columns, rows, summary = [] }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - 64;
    const colCount = columns.length;
    const totalWeight = columns.reduce((s, c) => s + (c.weight || 1), 0);
    const widths = columns.map((c) => ((c.weight || 1) / totalWeight) * pageWidth);

    const drawHeader = () => {
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(16).text(config.company.name, 32, 30);
      doc.fillColor('#1d4ed8').font('Helvetica-Bold').fontSize(11).text(title, 32, 50);
      doc.fillColor('#64748b').font('Helvetica').fontSize(8)
        .text(subtitle || `Generated ${new Date().toLocaleString('en-IN')}`, 32, 66, { width: pageWidth });
      doc.moveTo(32, 82).lineTo(32 + pageWidth, 82).strokeColor('#e2e8f0').stroke();
    };

    const drawTableHead = (y) => {
      doc.rect(32, y, pageWidth, 18).fill('#1d4ed8');
      let x = 32;
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
      columns.forEach((c, i) => {
        doc.text(String(c.header), x + 4, y + 5, { width: widths[i] - 8, align: c.align || 'left', lineBreak: false, ellipsis: true });
        x += widths[i];
      });
      return y + 18;
    };

    drawHeader();
    let y = drawTableHead(90);
    let page = 1;

    doc.font('Helvetica').fontSize(8);
    rows.forEach((r, idx) => {
      if (y > doc.page.height - 70) {
        doc.addPage();
        page += 1;
        drawHeader();
        y = drawTableHead(90);
        doc.font('Helvetica').fontSize(8);
      }
      const height = 16;
      if (idx % 2 === 1) doc.rect(32, y, pageWidth, height).fill('#f8fafc');
      let x = 32;
      doc.fillColor('#0f172a').font('Helvetica').fontSize(8);
      columns.forEach((c, i) => {
        const raw = c.value ? c.value(r) : r[c.key];
        const text = raw === null || raw === undefined || raw === '' ? '—' : String(raw);
        doc.text(text, x + 4, y + 4, { width: widths[i] - 8, align: c.align || 'left', lineBreak: false, ellipsis: true });
        x += widths[i];
      });
      doc.moveTo(32, y + height).lineTo(32 + pageWidth, y + height).strokeColor('#eef2f7').lineWidth(0.5).stroke();
      y += height;
    });

    if (rows.length === 0) {
      doc.fillColor('#64748b').fontSize(9).text('No records for the selected filters.', 36, y + 10);
      y += 30;
    }

    if (summary.length) {
      y += 12;
      if (y > doc.page.height - 110) { doc.addPage(); y = 50; }
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(9).text('Summary', 32, y);
      y += 14;
      doc.font('Helvetica').fontSize(8.5);
      summary.forEach(([label, value]) => {
        doc.fillColor('#475569').text(`${label}:`, 36, y, { width: 180, continued: true });
        doc.fillColor('#0f172a').font('Helvetica-Bold').text(` ${value}`);
        doc.font('Helvetica');
        y += 13;
      });
    }

    doc.fontSize(7).fillColor('#94a3b8')
      .text(`${config.company.name} — StockFlow inventory & billing · Page ${page}`, 32, doc.page.height - 28, { width: pageWidth, align: 'center' });

    doc.end();
  });
}

/** ── Printable invoice PDF ─────────────────────────────────────────────── */
function buildInvoicePdf(invoice) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 84;
    const C = config.company;

    doc.rect(0, 0, doc.page.width, 118).fill('#0f172a');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text(C.name, 42, 36);
    doc.font('Helvetica').fontSize(8.5).fillColor('#cbd5e1')
      .text(C.address, 42, 62, { width: W * 0.55 })
      .text(`${C.phone}  ·  ${C.email}  ·  GSTIN ${C.gstin}`, 42, 86, { width: W * 0.55 });

    doc.fillColor('#60a5fa').font('Helvetica-Bold').fontSize(22).text('INVOICE', 42, 36, { width: W, align: 'right' });
    doc.fillColor('#e2e8f0').font('Helvetica').fontSize(9)
      .text(invoice.invoice_no, 42, 64, { width: W, align: 'right' })
      .text(dateOnly(invoice.created_at), 42, 78, { width: W, align: 'right' });

    let y = 140;
    const colW = W / 2 - 10;
    doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(8).text('BILLED TO', 42, y);
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(11).text(invoice.customer_name || 'Walk-in customer', 42, y + 14, { width: colW });
    doc.font('Helvetica').fontSize(9).fillColor('#475569');
    let lineY = y + 32;
    [invoice.customer_phone, invoice.customer_email, invoice.customer_address].filter(Boolean).forEach((line) => {
      doc.text(String(line), 42, lineY, { width: colW });
      lineY += 13;
    });

    doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(8).text('PAYMENT DETAILS', 42 + colW + 20, y);
    doc.font('Helvetica').fontSize(9).fillColor('#475569');
    const meta = [
      ['Status', invoice.status.toUpperCase()],
      ['Payment method', String(invoice.payment_method || '').toUpperCase()],
      ['Billed by', invoice.created_by_name || '—'],
      ['Items', String((invoice.items || []).length)]
    ];
    meta.forEach(([k, v], i) => {
      doc.fillColor('#64748b').text(k, 42 + colW + 20, y + 14 + i * 14, { width: 100, continued: true });
      doc.fillColor('#0f172a').font('Helvetica-Bold').text(String(v));
      doc.font('Helvetica');
    });

    // items table
    y = 240;
    const cols = [
      { h: '#', w: 24, align: 'left' },
      { h: 'Product', w: W - 24 - 90 - 60 - 60 - 90, align: 'left' },
      { h: 'SKU', w: 90, align: 'left' },
      { h: 'Qty', w: 60, align: 'right' },
      { h: 'Rate', w: 60, align: 'right' },
      { h: 'Amount', w: 90, align: 'right' }
    ];
    doc.rect(42, y, W, 22).fill('#1d4ed8');
    let x = 42;
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5);
    cols.forEach((c) => {
      doc.text(c.h, x + 6, y + 7, { width: c.w - 12, align: c.align });
      x += c.w;
    });
    y += 22;

    doc.font('Helvetica').fontSize(9);
    (invoice.items || []).forEach((item, idx) => {
      if (y > doc.page.height - 210) { doc.addPage(); y = 60; }
      const rowH = 22;
      if (idx % 2 === 1) doc.rect(42, y, W, rowH).fill('#f8fafc');
      let cx = 42;
      const vals = [
        String(idx + 1), item.product_name, item.sku, String(item.quantity),
        money(item.unit_price), money(item.line_total)
      ];
      doc.fillColor('#0f172a');
      cols.forEach((c, i) => {
        doc.text(vals[i], cx + 6, y + 7, { width: c.w - 12, align: c.align, lineBreak: false, ellipsis: true });
        cx += c.w;
      });
      y += rowH;
    });

    // totals
    y += 10;
    const totalsX = 42 + W - 220;
    const line = (label, value, bold = false) => {
      doc.fillColor(bold ? '#0f172a' : '#475569').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9)
        .text(label, totalsX, y, { width: 110 })
        .text(value, totalsX + 110, y, { width: 110, align: 'right' });
      y += bold ? 20 : 15;
    };
    line('Subtotal', money(invoice.subtotal));
    if (Number(invoice.discount_amount) > 0) {
      const dLabel = invoice.discount_type === 'percent' ? `Discount (${invoice.discount_value}%)` : 'Discount';
      line(dLabel, '-' + money(invoice.discount_amount));
    }
    if (Number(invoice.tax_amount) > 0) line(`Tax (${invoice.tax_rate}%)`, money(invoice.tax_amount));
    doc.moveTo(totalsX, y).lineTo(totalsX + 220, y).strokeColor('#cbd5e1').stroke();
    y += 6;
    line('Total', money(invoice.total), true);

    if (invoice.notes) {
      doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(8).text('NOTES', 42, y - 40);
      doc.fillColor('#475569').font('Helvetica').fontSize(8.5).text(invoice.notes, 42, y - 26, { width: W * 0.55 });
    }

    if (invoice.status !== 'paid') {
      doc.save();
      doc.rotate(-20, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.fillColor(invoice.status === 'cancelled' ? '#dc2626' : '#d97706')
        .opacity(0.16).font('Helvetica-Bold').fontSize(90)
        .text(invoice.status.toUpperCase(), 0, doc.page.height / 2 - 60, { width: doc.page.width, align: 'center' });
      doc.restore();
      doc.opacity(1);
    }

    doc.fillColor('#94a3b8').font('Helvetica').fontSize(7.5)
      .text('Thank you for your business. This is a computer-generated invoice.', 42, doc.page.height - 60, { width: W, align: 'center' })
      .text(`${C.name} · Generated by StockFlow on ${new Date().toLocaleString('en-IN')}`, 42, doc.page.height - 46, { width: W, align: 'center' });

    doc.end();
  });
}

module.exports = { buildReportXlsx, buildReportPdf, buildInvoicePdf, money, shortDate, dateOnly, round2, toInt };
