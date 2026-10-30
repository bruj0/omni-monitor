/** Types for the plain-JS chart helpers, which esbuild bundles for the webview. */
export interface ChartPalette {
  blue: string;
  green: string;
  yellow: string;
  orange: string;
  purple: string;
  foreground: string;
  border: string;
}

export declare function chartPalette(): ChartPalette;
export declare function colorForLabel(label: string, palette: ChartPalette): string;
/** One trend point: a label, an optional requests count, and tokens. */
export interface TrendPoint {
  label: string;
  requests?: number;
  totalTokens: number;
}
export declare function trendChartConfig(points: TrendPoint[], palette: ChartPalette): unknown;
export declare function donutConfig(
  rows: Record<string, unknown>[],
  labelKey: string,
  valueKey: string,
  palette: ChartPalette,
  title: string,
): unknown;
