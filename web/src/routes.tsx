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

import type { RouteObject } from 'react-router';
import { AppShell } from './app/layout/AppShell';
import { NotFoundPage } from './app/pages/NotFoundPage';
import { ApprovalsPage } from './domains/approvals/ApprovalsPage';
import { OverviewPage } from './domains/overview/OverviewPage';
import { RepoDetailPage } from './domains/repos/RepoDetailPage';
import { ReposPage } from './domains/repos/ReposPage';
import { NewTaskPage } from './domains/tasks/NewTaskPage';
import { TaskDetailPage } from './domains/tasks/TaskDetailPage';
import { TaskListPage } from './domains/tasks/TaskListPage';

export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'tasks', element: <TaskListPage /> },
      { path: 'tasks/new', element: <NewTaskPage /> },
      { path: 'tasks/:taskId', element: <TaskDetailPage /> },
      { path: 'repos', element: <ReposPage /> },
      { path: 'repos/:owner/:name', element: <RepoDetailPage /> },
      { path: 'approvals', element: <ApprovalsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
