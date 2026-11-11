// Hash routing: the API server only serves files from dist, so `#/fleet` style routes need no
// server fallback. Non-route hashes (the skip link's `#main`) leave the current route alone.
import { useEffect, useState } from 'react';

/** `#/fleet/<id>`, `#/launch`, `#/history?worker=<id>`, `#/docs/<slug>#<anchor>`. */
export function parseRoute(hash) {
  const raw = hash.replace(/^#/, '');
  if (raw === '' || raw === '/') return { page: 'fleet', workerId: null };
  if (!raw.startsWith('/')) return null;
  const [path, query = ''] = raw.split('?');
  if (path.startsWith('/docs')) {
    const [docPath, anchor = null] = raw.slice(5).split('#');
    return { page: 'docs', slug: docPath.replace(/^\//, '') || null, anchor };
  }
  const [, page, id] = path.split('/');
  if (page === 'fleet') return { page, workerId: id ? decodeURIComponent(id) : null };
  if (page === 'launch') return { page };
  if (page === 'history') return { page, workerId: new URLSearchParams(query).get('worker') };
  return { page: 'not-found' };
}

export const href = {
  fleet: (id) => (id ? `#/fleet/${encodeURIComponent(id)}` : '#/fleet'),
  launch: () => '#/launch',
  history: (id) => (id ? `#/history?worker=${encodeURIComponent(id)}` : '#/history'),
  docs: (slug, anchor) => `#/docs${slug ? `/${slug}` : ''}${anchor ? `#${anchor}` : ''}`,
};

/** `/docs/<slug>#<anchor>` links from @factory/docs become in-app hash routes. */
export const appHref = (target) => (target.startsWith('/docs') ? `#${target}` : target);

export function navigate(target) {
  window.location.hash = target.replace(/^#/, '');
}

export function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash) ?? { page: 'fleet', workerId: null });
  useEffect(() => {
    const onChange = () => {
      const next = parseRoute(window.location.hash);
      if (next) setRoute(next);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
