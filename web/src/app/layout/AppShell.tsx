/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

import AppLayout from '@cloudscape-design/components/app-layout';
import SideNavigation, { type SideNavigationProps } from '@cloudscape-design/components/side-navigation';
import TopNavigation, { type TopNavigationProps } from '@cloudscape-design/components/top-navigation';
import { applyMode, Mode } from '@cloudscape-design/global-styles';
import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import type { PendingApprovalSummary } from '../../core/api/types';
import { formatRelativeTime, taskHref } from '../../core/util/format';
import { usePendingApprovals } from '../../domains/approvals/hooks';
import { useAuth } from '../providers/auth/AuthProvider';

const THEME_KEY = 'abca-console-theme';

const NAV_ITEMS: SideNavigationProps.Item[] = [
  { type: 'link', text: 'Overview', href: '/' },
  { type: 'link', text: 'Tasks', href: '/tasks' },
  { type: 'link', text: 'Repositories', href: '/repos' },
  { type: 'link', text: 'Costs', href: '/costs' },
];

/** Crescent moon: shown in light mode, switches to dark. */
const MOON_ICON = (
  <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
    <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
  </svg>
);

/** Sun: shown in dark mode, switches to light. */
const SUN_ICON = (
  <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
    <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
    <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const REASON_LENGTH = 60;

function shortReason(reason: string): string {
  return reason.length > REASON_LENGTH ? `${reason.slice(0, REASON_LENGTH - 1)}…` : reason;
}

/**
 * The bell in the top bar: notifications, which today are approval requests. A dot
 * shows when one is waiting; each opens its task, and the approvals page lists them all.
 */
function approvalsMenu(pending: readonly PendingApprovalSummary[]): TopNavigationProps.MenuDropdownUtility {
  const count = pending.length;
  const items: TopNavigationProps.MenuDropdownUtility['items'] = count === 0
    ? [{ id: 'none', text: 'No notifications', disabled: true }]
    : [
      ...pending.map((p) => ({
        id: `approval:${p.request_id}`,
        text: shortReason(p.reason),
        secondaryText: `${p.tool_name} · asked ${formatRelativeTime(p.created_at)}`,
        href: taskHref(p.task_id),
      })),
      { id: 'all', text: count === 1 ? 'Open approval requests' : `See all ${count} approval requests`, href: '/approvals' },
    ];
  return {
    type: 'menu-dropdown',
    iconName: 'notification',
    ariaLabel: count === 0 ? 'Notifications: none' : `Notifications: ${count} approval ${count === 1 ? 'request' : 'requests'}`,
    title: count === 0 ? 'Notifications' : `Approval ${count === 1 ? 'request' : 'requests'} (${count})`,
    badge: count > 0,
    items,
  };
}

/** Highlights the nav entry for the current route, including nested routes like /tasks/:id. */
function activeHref(pathname: string): string {
  const match = NAV_ITEMS.filter((item) => item.type === 'link' && item.href !== '/')
    .map((item) => (item as SideNavigationProps.Link).href)
    .find((href) => pathname === href || pathname.startsWith(`${href}/`));
  return match ?? '/';
}

function useTheme(): [Mode, () => void] {
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem(THEME_KEY) === Mode.Dark ? Mode.Dark : Mode.Light));
  useEffect(() => {
    applyMode(mode);
    localStorage.setItem(THEME_KEY, mode);
  }, [mode]);
  return [mode, () => setMode((m) => (m === Mode.Dark ? Mode.Light : Mode.Dark))];
}

export function AppShell() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { state, signOut } = useAuth();
  const [mode, toggleMode] = useTheme();
  const email = state.status === 'signed-in' ? state.session.user.email : '';
  const pending = usePendingApprovals().data?.pending ?? [];

  const follow = (event: CustomEvent<{ href?: string; external?: boolean }>) => {
    const { href, external } = event.detail;
    if (external || !href) return;
    event.preventDefault();
    navigate(href);
  };

  return (
    <>
      <div id="top-nav" style={{ position: 'sticky', top: 0, zIndex: 1002 }}>
        <TopNavigation
          identity={{ href: '/', title: 'ABCA Operator Console', onFollow: follow }}
          utilities={[
            { ...approvalsMenu(pending), onItemFollow: follow },
            {
              type: 'button',
              iconSvg: mode === Mode.Dark ? SUN_ICON : MOON_ICON,
              ariaLabel: mode === Mode.Dark ? 'Switch to light mode' : 'Switch to dark mode',
              title: mode === Mode.Dark ? 'Switch to light mode' : 'Switch to dark mode',
              onClick: toggleMode,
            },
            {
              type: 'menu-dropdown',
              text: email,
              iconName: 'user-profile',
              items: [{ id: 'sign-out', text: 'Sign out' }],
              onItemClick: ({ detail }) => detail.id === 'sign-out' && signOut(),
            },
          ]}
        />
      </div>
      <AppLayout
        headerSelector="#top-nav"
        toolsHide
        navigation={
          <SideNavigation
            header={{ href: '/', text: 'Factory' }}
            activeHref={activeHref(pathname)}
            items={NAV_ITEMS}
            onFollow={follow}
          />
        }
        content={<Outlet />}
      />
    </>
  );
}
