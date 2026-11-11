import React from 'react';
import { StatusPill, Link } from '@factory/ui';
import { statusInfo } from '@factory/docs';
import { appHref } from './routes.js';

/**
 * StatusPill with the docs' plain-words label and meaning. The role comes from @factory/ui's map,
 * so `failed`/`TimedOut` are danger and `terminating` is progress; an unknown value keeps its raw
 * text with the `unknown` role instead of defaulting to a colour.
 */
export function Status({ value, domain = 'skid-worker', tooltip = undefined, size = undefined }) {
  const info = statusInfo('skidbladnir', String(value ?? 'unknown'), domain);
  return (
    <StatusPill
      app="skidbladnir"
      value={value ?? 'unknown'}
      label={info?.label}
      size={size}
      tooltip={tooltip}
      description={
        info && (
          <>
            {info.short} <Link href={appHref(info.href)}>Learn more</Link>
          </>
        )
      }
    />
  );
}

/** "Learn more" link into the docs for `PageHeader learnMore` (kept on one line with any hint). */
export function LearnMore({ href }) {
  return href ? (
    <Link href={appHref(href)} className="text-accent-fg underline underline-offset-4">
      Learn more
    </Link>
  ) : null;
}

export const TEMPLATE_LABELS = { general: 'General purpose', node: 'Node.js workspace', python: 'Python workspace' };
export const templateLabel = (t) => TEMPLATE_LABELS[t] ?? t;
