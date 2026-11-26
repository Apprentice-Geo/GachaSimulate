/** Preserve the view model's formatted value while styling its unit separately. */
export function ResultValue({ value, unit }: { value: string; unit: string }) {
  const suffix = unit ? ` ${unit}` : "";
  const has_unit = suffix && value.endsWith(suffix);
  const number = has_unit ? value.slice(0, -suffix.length) : value;
  return (
    <>
      <span className="result-number">{number}</span>
      {has_unit && <small>{suffix}</small>}
    </>
  );
}
