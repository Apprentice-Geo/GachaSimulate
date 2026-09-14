/** Preserve the view model's formatted value while styling its unit separately. */
export function ResultValue({ value, unit }: { value: string; unit: string }) {
  const suffix = unit ? ` ${unit}` : "";
  if (!suffix || !value.endsWith(suffix))
    return <span className="result-number">{value}</span>;
  return (
    <>
      <span className="result-number">{value.slice(0, -suffix.length)}</span>
      <small>{suffix}</small>
    </>
  );
}
