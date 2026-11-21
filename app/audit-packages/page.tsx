import { WorkspaceHeader } from '@/app/quickbooks/icons';

const placeholderSections = [
  {
    title: 'Audit type templates',
    description: 'Audit types and their requirements will be defined with you.',
  },
  {
    title: 'Evidence requests',
    description: 'Request lists will be set up to match each audit type you choose.',
  },
  {
    title: 'Package contents',
    description: 'The package structure will follow the requirements you define.',
  },
];

export default function AuditPackagesPage() {
  return (
    <div className="workspacePage">
      <WorkspaceHeader />
      <main className="workspaceContent">
      <section className="mx-auto max-w-6xl">
        <header className="mb-8 border-b border-[#e4e7ec] pb-7">
          <p className="text-sm font-semibold uppercase tracking-[0.14em] text-[#3159c9]">Purpose-built exports</p>
          <h1 className="mt-3 text-3xl font-semibold">Audit packages</h1>
          <p className="mt-3 max-w-2xl text-base leading-7 text-[#667085]">
            Build an organized evidence package for the kind of audit you’re preparing for. We’ll shape the checklists and requests with you.
          </p>
        </header>

        <div className="grid gap-4 md:grid-cols-3">
          {placeholderSections.map((section) => (
            <section key={section.title} className="min-h-56 rounded-2xl border border-[#e4e7ec] bg-white p-6 shadow-[0_1px_3px_rgba(16,24,40,.04)]">
              <span className="inline-flex rounded-full bg-[#eef3ff] px-3 py-1 text-xs font-semibold uppercase tracking-wide text-[#3159c9]">
                Planned
              </span>
              <h2 className="mt-5 text-lg font-semibold">{section.title}</h2>
              <p className="mt-3 text-sm leading-6 text-[#667085]">{section.description}</p>
            </section>
          ))}
        </div>
      </section>
      </main>
    </div>
  );
}
