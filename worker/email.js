// Notification emails: one description per email, rendered both as HTML (institute heritage style, inline
// styles and tables so it survives Gmail and Outlook) and as a plain-text copy for clients that block HTML.
//
// renderEmail({ base, title, tag, tone, greeting, paras, facts, note, action }) -> { html, text }
//   base    portal address, for the header image and links
//   tag     short status label in the title band; tone: 'blue' | 'amber' | 'green' | 'grey'
//   paras   plain sentences; facts: [[label, value], ...]; note: { label, text }; action: { label, url }

const TONES = {
  blue: ['#e3ebf7', '#0b3d91'],
  amber: ['#fbeedd', '#8a4b0f'],
  green: ['#e4f3ea', '#2e7d4f'],
  grey: ['#eceae4', '#374151'],
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SANS = "Arial, Helvetica, sans-serif";
const SERIF = "Georgia, 'Times New Roman', serif";

export function renderEmail({ base, title, tag, tone = 'grey', greeting, paras = [], facts = [], note, action, logo }) {
  const [tagBg, tagFg] = TONES[tone] || TONES.grey;
  const img = logo || `${base}/email-header.png`;

  const factRows = facts.map(([k, v]) => `
                <tr>
                  <td style="padding:6px 12px 6px 0;font-family:${SANS};font-size:13px;color:#5b6573;white-space:nowrap;vertical-align:top;">${esc(k)}</td>
                  <td style="padding:6px 0;font-family:${SANS};font-size:14px;color:#1f2933;font-weight:bold;vertical-align:top;">${esc(v)}</td>
                </tr>`).join('');

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f6f4ee;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f4ee;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e3dccb;border-radius:6px;">
        <tr><td align="center" style="padding:16px 20px;background:#ffffff;border-radius:6px 6px 0 0;">
          <img src="${esc(img)}" width="520" alt="Sri Sathya Sai Institute of Higher Learning, CIE Scripts Submission Portal" style="display:block;width:100%;max-width:520px;height:auto;border:0;">
        </td></tr>
        <tr><td style="background:#0b3d91;border-top:3px solid #d9822b;padding:20px 24px;">
          <div style="font-family:${SERIF};font-size:23px;line-height:1.25;font-weight:bold;color:#ffffff;">${esc(title)}</div>
          ${tag ? `<div style="margin-top:10px;"><span style="display:inline-block;padding:3px 9px;border-radius:4px;background:${tagBg};color:${tagFg};font-family:${SANS};font-size:12px;font-weight:bold;">${esc(tag)}</span></div>` : ''}
        </td></tr>
        <tr><td style="height:2px;line-height:2px;font-size:0;background:#ffffff;">&nbsp;</td></tr>
        <tr><td style="height:1px;line-height:1px;font-size:0;background:#b08d57;">&nbsp;</td></tr>
        <tr><td style="padding:24px 24px 8px;font-family:${SANS};font-size:15px;line-height:1.6;color:#1f2933;">
          ${greeting ? `<p style="margin:0 0 14px;">${esc(greeting)}</p>` : ''}
          ${paras.map(p => `<p style="margin:0 0 14px;">${esc(p)}</p>`).join('\n          ')}
        </td></tr>
        ${facts.length ? `<tr><td style="padding:4px 24px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#faf8f3;border:1px solid #e3dccb;border-radius:4px;">
            <tr><td style="padding:10px 14px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">${factRows}
              </table>
            </td></tr>
          </table>
        </td></tr>` : ''}
        ${note?.text ? `<tr><td style="padding:12px 24px 4px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fbf3e6;border-left:4px solid #d9822b;border-radius:4px;">
            <tr><td style="padding:12px 14px;font-family:${SANS};font-size:14px;line-height:1.55;color:#1f2933;">
              <div style="font-weight:bold;color:#8a4b0f;margin-bottom:4px;">${esc(note.label)}</div>
              <div style="white-space:pre-wrap;">${esc(note.text)}</div>
            </td></tr>
          </table>
        </td></tr>` : ''}
        ${action ? `<tr><td style="padding:20px 24px 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="background:#0b3d91;border-radius:4px;">
              <a href="${esc(action.url)}" style="display:inline-block;padding:12px 22px;font-family:${SANS};font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">${esc(action.label)}</a>
            </td>
          </tr></table>
          <p style="margin:12px 0 0;font-family:${SANS};font-size:12px;line-height:1.5;color:#5b6573;">If the button does not work, open this address:<br><a href="${esc(action.url)}" style="color:#0b3d91;word-break:break-all;">${esc(action.url)}</a></p>
        </td></tr>` : ''}
        <tr><td style="padding:20px 24px 0;">&nbsp;</td></tr>
        <tr><td align="center" style="padding:16px 24px 18px;background:#faf8f3;border-top:1px solid #e3dccb;border-radius:0 0 6px 6px;font-family:${SANS};font-size:12px;line-height:1.6;color:#5b6573;">
          <span style="font-family:${SERIF};font-size:14px;font-weight:bold;color:#0b3d91;">Sri Sathya Sai Institute of Higher Learning</span><br>
          CIE Scripts Submission Portal<br>
          This is an automated message from the portal.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    title.toUpperCase(),
    tag ? `Status: ${tag}` : '',
    '',
    greeting || '',
    greeting ? '' : null,
    ...paras.flatMap(p => [p, '']),
    ...(facts.length ? [...facts.map(([k, v]) => `${k}: ${v}`), ''] : []),
    ...(note?.text ? [`${note.label}:`, note.text, ''] : []),
    ...(action ? [`${action.label}: ${action.url}`, ''] : []),
    'CIE Scripts Submission Portal',
    'Sri Sathya Sai Institute of Higher Learning',
  ].filter(l => l !== null).join('\n');

  return { html, text };
}

// The portal's notifications. who = the person acting; time = IST timestamp.
export const emails = {
  forward: ({ base, campus, courses, who, time }) => renderEmail({
    base, title: 'Entries forwarded for your review', tag: 'Awaiting your review', tone: 'blue',
    greeting: 'Dear Director,',
    paras: [
      `The ${campus} campus office has completed the CIE script submission entries for all ${courses} courses and forwarded them for your review.`,
      'Please check the entries. If there is no discrepancy, click Submit. If anything needs correcting, click Return for correction with a note, and the campus office will be able to edit the entries again.',
    ],
    facts: [['Campus', campus], ['Courses', String(courses)], ['Forwarded by', who], ['Forwarded on', `${time} IST`]],
    action: { label: `Review the ${campus} entries`, url: `${base}/director/${campus}` },
  }),
  return: ({ base, campus, who, time, note }) => renderEmail({
    base, title: 'Entries returned for correction', tag: 'Returned for correction', tone: 'amber',
    greeting: `Dear ${campus} campus office,`,
    paras: [
      `The director has returned the ${campus} CIE script submission entries for correction. They are open for editing again.`,
      'Please make the corrections and forward to the director once more.',
    ],
    facts: [['Campus', campus], ['Returned by', who], ['Returned on', `${time} IST`]],
    note: { label: "Director's note", text: note },
    action: { label: `Open the ${campus} portal`, url: `${base}/campus/${campus}` },
  }),
  submit: ({ base, campus, who, time }) => renderEmail({
    base, title: `${campus} campus has submitted`, tag: 'Submitted', tone: 'green',
    greeting: 'Dear CoE Office,',
    paras: [
      `The ${campus} campus has submitted its CIE script submissions. The director reviewed the entries and found no discrepancy.`,
      `The ${campus} entries are now final and locked.`,
    ],
    facts: [['Campus', campus], ['Approved by', who], ['Submitted on', `${time} IST`]],
    action: { label: 'View all campuses', url: `${base}/admin` },
  }),
  reopen: ({ base, campus, who, time, note }) => renderEmail({
    base, title: 'Entries reopened for editing', tag: 'Reopened for editing', tone: 'amber',
    greeting: `Dear ${campus} campus office,`,
    paras: [
      `The CoE office has reopened the ${campus} CIE script submission entries for editing.`,
      'Please make any changes and forward to the director again.',
    ],
    facts: [['Campus', campus], ['Reopened by', who], ['Reopened on', `${time} IST`]],
    note: note ? { label: 'Note', text: note } : null,
    action: { label: `Open the ${campus} portal`, url: `${base}/campus/${campus}` },
  }),
  test: ({ base }) => renderEmail({
    base, title: 'Test email', tag: 'Notifications are working', tone: 'grey',
    paras: ['This is a test email from the CIE Scripts Submission Portal.', 'If you received it, notifications are working.'],
    action: { label: 'Open the portal', url: base },
  }),
};
