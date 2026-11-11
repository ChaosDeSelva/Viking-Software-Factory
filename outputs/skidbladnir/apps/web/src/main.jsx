import React, { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell, Badge, GlossaryProvider, LinkProvider, Tooltip, useUrlState } from '@factory/ui';
import { getTerm, glossary, screenHref, termHref } from '@factory/docs';
import { projectSnapshot } from '../../../packages/contracts/worker.mjs';
import { appHref, href, useRoute } from './routes.js';
import { useFleet } from './useFleet.js';
import { FleetPage } from './pages/Fleet.jsx';
import { LaunchPage } from './pages/Launch.jsx';
import { HistoryPage } from './pages/History.jsx';
import { DocsPage } from './pages/Docs.jsx';
import { NotFoundPage } from './pages/NotFound.jsx';
import { AskDrawer } from './AskDrawer.jsx';
import { switcherApps } from './apps.js';
import './style.css';

const PAGE_TITLES = {
  fleet: 'Worker fleet',
  launch: 'Launch',
  history: 'Event history',
  docs: 'Docs',
  'not-found': 'Not found',
};
// Docs section for each screen: the bottom-bar Docs link opens the guide for the current page.
const SCREEN_IDS = { fleet: 'fleet', launch: 'launch', history: 'history' };

const renderLink = (props) => <a {...props} href={appHref(props.href)} />;
const glossaryHref = (term) => {
  const entry = getTerm(term);
  return appHref(entry ? termHref(entry) : '/docs/glossary');
};

function App() {
  const route = useRoute();
  const fleet = useFleet();
  const [projectParam, setProjectParam] = useUrlState('project', '');
  const [askOpen, setAskOpen] = useState(false);
  const project = projectParam || null;
  const aws = fleet.data?.mode === 'aws';

  // Projects are the distinct project labels workers carry; the selected one stays listed even
  // before any worker uses it (e.g. a bookmarked `?project=`).
  const projects = useMemo(() => {
    const ids = new Set((fleet.data?.workers ?? []).map((w) => w.project).filter(Boolean));
    if (project) ids.add(project);
    return [...ids].sort().map((id) => ({ id, name: id }));
  }, [fleet.data?.workers, project]);
  const scoped = useMemo(() => (fleet.data ? projectSnapshot(fleet.data, project) : null), [fleet.data, project]);

  const global = route.page === 'docs';

  const here = window.location.origin + '/';
  const apps = switcherApps(here, project);
  const tabs = [
    { id: 'fleet', label: 'Worker fleet', href: href.fleet() },
    { id: 'launch', label: 'Launch', href: href.launch() },
    { id: 'history', label: 'Event history', href: href.history() },
  ];
  const docsTarget = SCREEN_IDS[route.page] ? screenHref('skidbladnir', SCREEN_IDS[route.page]) : '/docs';
  const modeChip = fleet.data && (
    <Tooltip
      content={
        aws
          ? `Cloud mode: real machines in account ${fleet.data.accountId}, ${fleet.data.region}. They cost money until terminated.`
          : 'Simulation mode: no machines, no cloud resources, no charges.'
      }
    >
      <button
        type="button"
        className="inline-flex cursor-default rounded-md px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <span className="sr-only">Mode: </span>
        <Badge tone={aws ? 'warning' : 'neutral'}>
          {aws ? (
            <>
              AWS<span className="max-sm:hidden"> · {fleet.data.region}</span>
            </>
          ) : (
            'Simulation'
          )}
        </Badge>
      </button>
    </Tooltip>
  );

  const pageProps = { fleet, scoped, project, aws, route, setProject: (id) => setProjectParam(id ?? '') };
  return (
    <LinkProvider render={renderLink}>
      <GlossaryProvider entries={glossary} docsHref={glossaryHref}>
        <AppShell
          appName="Skidbladnir"
          pageTitle={
            route.page === 'fleet' && route.workerId
              ? (fleet.data?.workers.find((w) => w.id === route.workerId)?.name ?? PAGE_TITLES.fleet)
              : PAGE_TITLES[route.page]
          }
          routeKey={route.page}
          apps={apps}
          currentApp="skidbladnir"
          projects={projects}
          projectId={project}
          onProjectChange={(id) => setProjectParam(id ?? '')}
          allowAllProjects
          projectPickerDisabledReason={global ? 'Docs are the same for every project.' : undefined}
          tabs={tabs}
          activeTabId={global ? undefined : route.page}
          connection={{
            state: /** @type {import('@factory/ui').ConnectionState} */ (fleet.connection),
            detail:
              fleet.sessionError ||
              (fleet.connection === 'live'
                ? 'Live updates from the local API at ' + window.location.host
                : 'Waiting for the local API at ' + window.location.host),
            onReconnect: fleet.reconnect,
          }}
          globalLinks={[{ id: 'setup-guide', label: 'Setup guide', href: '/site/guide.html', icon: 'external' }]}
          docsHref={appHref(docsTarget)}
          onAsk={() => setAskOpen(true)}
          extra={modeChip}
        >
          {route.page === 'fleet' && <FleetPage {...pageProps} />}
          {route.page === 'launch' && <LaunchPage {...pageProps} />}
          {route.page === 'history' && <HistoryPage {...pageProps} />}
          {route.page === 'docs' && <DocsPage route={route} />}
          {route.page === 'not-found' && <NotFoundPage />}
          <AskDrawer open={askOpen} onOpenChange={setAskOpen} docsHref={appHref(docsTarget)} />
        </AppShell>
      </GlossaryProvider>
    </LinkProvider>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
