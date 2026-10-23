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
import TopNavigation from '@cloudscape-design/components/top-navigation';
import { applyMode, Mode } from '@cloudscape-design/global-styles';
import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../providers/auth/AuthProvider';

const THEME_KEY = 'abca-console-theme';

const NAV_ITEMS: SideNavigationProps.Item[] = [
  { type: 'link', text: 'Overview', href: '/' },
  { type: 'link', text: 'Tasks', href: '/tasks' },
  { type: 'link', text: 'Approvals', href: '/approvals' },
];

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
            {
              type: 'button',
              text: mode === Mode.Dark ? 'Light mode' : 'Dark mode',
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
