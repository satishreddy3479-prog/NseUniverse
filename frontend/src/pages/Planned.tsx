import { Link } from "react-router-dom";
import { Panel } from "../components/ui";

export function Planned({ title, when, children }: { title: string; when: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-4">
      <h1 className="text-xl font-semibold">{title}</h1>
      <Panel title={`Planned for ${when}`}>
        <div className="flex max-w-[65ch] flex-col gap-3 text-sm text-muted">
          {children}
          <p>
            Captured snapshots can already be viewed in <Link className="text-info underline-offset-2 hover:underline" to="/data">Data & sessions</Link>.
          </p>
        </div>
      </Panel>
    </div>
  );
}
