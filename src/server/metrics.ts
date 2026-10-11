// Prometheus text exposition, hand-rolled (D24): two labelled counters, gauges
// read at scrape time, one latency histogram. Not worth prom-client.
// Format: https://prometheus.io/docs/instrumenting/exposition_formats/

const COUNTERS = {
  osmcp_invocations_total: "Downstream tool invocations by server and result.",
  osmcp_find_tools_total: "find_tools calls by result confidence.",
};
export type CounterName = keyof typeof COUNTERS;

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]; // seconds
const HIST = "osmcp_invoke_duration_seconds";

export class Metrics {
  private counters = new Map<CounterName, Map<string, number>>();
  private gauges = new Map<string, { help: string; type: "gauge" | "counter"; read: () => number }>();
  private hist = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };

  inc(name: CounterName, labels: Record<string, string> = {}, by = 1): void {
    const series = this.counters.get(name) ?? new Map<string, number>();
    const key = labelString(labels);
    series.set(key, (series.get(key) ?? 0) + by);
    this.counters.set(name, series);
  }

  /** One downstream invoke took `seconds`. */
  observeInvoke(seconds: number): void {
    BUCKETS.forEach((le, i) => {
      if (seconds <= le) this.hist.buckets[i]++;
    });
    this.hist.sum += seconds;
    this.hist.count++;
  }

  /** A value owned elsewhere (live sessions, vault state), read at scrape time. */
  gauge(name: string, help: string, read: () => number, type: "gauge" | "counter" = "gauge"): void {
    this.gauges.set(name, { help, type, read });
  }

  render(): string {
    const out: string[] = [];
    for (const [name, help] of Object.entries(COUNTERS) as [CounterName, string][]) {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
      for (const [labels, v] of this.counters.get(name) ?? []) out.push(`${name}${labels} ${v}`);
    }
    for (const [name, g] of this.gauges) {
      let v: number;
      try {
        v = g.read();
      } catch {
        v = NaN; // a broken source shows as NaN rather than failing the whole scrape
      }
      out.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} ${g.type}`, `${name} ${v}`);
    }
    out.push(`# HELP ${HIST} Downstream invoke latency in seconds.`, `# TYPE ${HIST} histogram`);
    BUCKETS.forEach((le, i) => out.push(`${HIST}_bucket{le="${le}"} ${this.hist.buckets[i]}`));
    out.push(`${HIST}_bucket{le="+Inf"} ${this.hist.count}`, `${HIST}_sum ${this.hist.sum}`, `${HIST}_count ${this.hist.count}`);
    return out.join("\n") + "\n";
  }
}

function labelString(labels: Record<string, string>): string {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}
