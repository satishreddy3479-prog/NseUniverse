import { useSearchParams } from "react-router-dom";
import { AlertsTab, AuditTab, ConfigTab, MaintenanceTab } from "../components/servermgmt/AdminTabs";
import { Async, Badge, useServerQuery } from "../components/servermgmt/common";
import { OverviewTab, StorageTab } from "../components/servermgmt/StorageTabs";
import { CacheTab, ExplorerTab, JobsTab, LogsTab, ProcessesTab, ReleasesTab, ResourcesTab, ServicesTab } from "../components/servermgmt/ResourceTabs";
import { serverApi } from "../lib/serverApi";

const TABS = [
  ["overview", "Overview"], ["storage", "Storage analytics"], ["explorer", "Filesystem"], ["resources", "CPU and RAM"], ["processes", "Processes"], ["logs", "Logs"],
  ["services", "Services"], ["jobs", "Jobs"], ["cache", "Cache"], ["releases", "Releases"], ["maintenance", "Maintenance"], ["alerts", "Alerts"], ["audit", "Audit"], ["config", "Configuration"],
] as const;
type TabId = (typeof TABS)[number][0];

/** Server Management Centre: monitoring first, controlled maintenance second. Every figure shows its collection time. */
export function ServerManagement() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find(([id]) => id === params.get("tab"))?.[0] ?? "overview") as TabId;
  const go = (t: string) => setParams({ tab: t });
  const o = useServerQuery(["overview"], serverApi.overview, 30_000);
  const open = o.data?.alerts.length ?? 0;
  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-3" data-testid="server-management">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Server Management Centre</h1>
        <p className="text-xs text-muted">Monitoring and approved maintenance for the NSE Universe server · times in IST</p>
      </div>
      <nav aria-label="Server management sections" className="flex gap-1 overflow-x-auto pb-1">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" aria-current={tab === id ? "page" : undefined} onClick={() => go(id)} ref={(el) => { if (el && tab === id) el.scrollIntoView?.({ inline: "center", block: "nearest" }); }}
            className={`inline-flex min-h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border px-3 text-sm ${tab === id ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate text-muted hover:text-paper"}`}>
            {label}{id === "alerts" && open > 0 && <Badge kind={o.data!.alerts.some((a) => a.level === "critical") ? "critical" : "warning"}>{open}</Badge>}
          </button>
        ))}
      </nav>
      {tab === "overview" && <Async q={o} what="The overview">{(d) => <OverviewTab o={d} onJump={go} />}</Async>}
      {tab === "storage" && <Async q={o} what="The overview">{(d) => <StorageTab o={d} />}</Async>}
      {tab === "explorer" && <ExplorerTab />}
      {tab === "resources" && <ResourcesTab />}
      {tab === "processes" && <ProcessesTab />}
      {tab === "logs" && <LogsTab />}
      {tab === "services" && <ServicesTab />}
      {tab === "jobs" && <JobsTab />}
      {tab === "cache" && <CacheTab />}
      {tab === "releases" && <ReleasesTab />}
      {tab === "maintenance" && <MaintenanceTab />}
      {tab === "alerts" && <AlertsTab />}
      {tab === "audit" && <AuditTab />}
      {tab === "config" && <ConfigTab />}
    </div>
  );
}
