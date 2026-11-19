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
        <header className="mb-8 border-b border-[#d9dde5] pb-6">
          <p className="text-sm font-semibold uppercase tracking-[0.14em] text-[#6c7973]">Coming into focus</p>
          <h1 className="mt-3 text-3xl font-semibold">Audit packages</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#5d6675]">
            Build an organized evidence package for the kind of audit you’re preparing for. We’ll shape the checklists and requests with you.
          </p>
        </header>

        <div className="grid gap-4 md:grid-cols-3">
          {placeholderSections.map((section) => (
            <section key={section.title} className="min-h-48 rounded-lg border border-dashed border-[#c8ced8] bg-white p-5">
              <span className="inline-flex rounded-full bg-[#eef1f5] px-3 py-1 text-xs font-semibold uppercase tracking-wide text-[#5d6675]">
                Placeholder
              </span>
              <h2 className="mt-5 text-lg font-semibold">{section.title}</h2>
              <p className="mt-2 text-sm leading-6 text-[#5d6675]">{section.description}</p>
            </section>
          ))}
        </div>
      </section>
      </main>
    </div>
  );
}
