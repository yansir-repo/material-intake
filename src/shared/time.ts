/**
 * unix 秒 → ISO 8601（UTC，到秒）。纯算术（Howard Hinnant 的 civil_from_days），不经 Date：
 * 时间只从 Clock 读进来，这里只格式化。
 */
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export const isoOf = (seconds: number): string => {
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const rem = s - days * 86400;
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}T${pad(Math.floor(rem / 3600))}:${pad(Math.floor((rem % 3600) / 60))}:${pad(rem % 60)}Z`;
};
