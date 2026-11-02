// Short times for the bot list (WR2). Pure: `now` is passed in. Local time, English names, no Intl (its output differs by ICU version).
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Today "7:34 PM", yesterday "Yesterday", within 6 days "Tuesday", this year "Aug 23", older "Aug 23, 2025". */
export function shortTime(ms, now) {
  const d = new Date(ms);
  const n = new Date(now);
  const age = Math.round((dayStart(n) - dayStart(d)) / 86_400_000);
  if (age <= 0) return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "AM" : "PM"}`;
  if (age === 1) return "Yesterday";
  if (age <= 6) return DAYS[d.getDay()];
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === n.getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}
