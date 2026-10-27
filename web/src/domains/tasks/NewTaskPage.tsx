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

import Autosuggest from '@cloudscape-design/components/autosuggest';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import RadioGroup from '@cloudscape-design/components/radio-group';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Textarea from '@cloudscape-design/components/textarea';
import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../../core/api/client';
import { CODING_WORKFLOW_ID } from '../../core/api/types';
import { taskHref } from '../../core/util/format';
import { useCreateTask, useRepoIssues, useTaskList } from './hooks';

/** Same rule as the API (`cdk/src/handlers/shared/validation.ts`). */
const REPO_PATTERN = /^(?!\.+\/)[a-zA-Z0-9._-]+\/(?!\.+$)[a-zA-Z0-9._-]+$/;
const MAX_DESCRIPTION_LENGTH = 10_000;

type Mode = 'describe' | 'issue';

interface Errors {
  readonly repo?: string;
  readonly issue?: string;
  readonly description?: string;
}

function validate(repo: string, mode: Mode, issue: string, description: string): Errors {
  const errors: { repo?: string; issue?: string; description?: string } = {};
  if (!REPO_PATTERN.test(repo.trim())) errors.repo = 'Enter the repository as owner/name, for example acme/website.';
  if (mode === 'issue' && !/^[1-9]\d*$/.test(issue.trim())) errors.issue = 'Enter the issue number, for example 12.';
  if (mode === 'describe' && !description.trim()) errors.description = 'Describe the change you want.';
  if (description.length > MAX_DESCRIPTION_LENGTH) errors.description = `Keep it under ${MAX_DESCRIPTION_LENGTH.toLocaleString()} characters.`;
  return errors;
}

function submitError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'REPO_NOT_ONBOARDED') {
    return 'This repository is not set up for agents yet. Ask your admin to add it, then try again.';
  }
  return error instanceof Error ? error.message : String(error);
}

export function NewTaskPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const create = useCreateTask();
  const tasks = useTaskList();

  const [repo, setRepo] = useState(params.get('repo') ?? '');
  const [mode, setMode] = useState<Mode>(params.get('issue') ? 'issue' : 'describe');
  const [issue, setIssue] = useState(params.get('issue') ?? '');
  const [description, setDescription] = useState(params.get('description') ?? '');
  const [showErrors, setShowErrors] = useState(false);

  const knownRepos = useMemo(() => {
    const repos = new Set((tasks.data?.pages.flatMap((p) => p.data) ?? []).map((t) => t.repo).filter((r): r is string => !!r));
    return [...repos].sort().map((value) => ({ value }));
  }, [tasks.data]);

  const repoLooksValid = REPO_PATTERN.test(repo.trim());
  const issues = useRepoIssues(repo.trim(), mode === 'issue' && repoLooksValid);
  // null data: this deployment has no console API, so fall back to typing the number.
  const pickerAvailable = issues.data !== null;
  const issueOptions = (issues.data?.issues ?? []).map((i) => ({
    value: String(i.number),
    label: `#${i.number} ${i.title}`,
    tags: [...i.labels],
  }));
  const chosenIssue = issues.data?.issues.find((i) => String(i.number) === issue.trim());

  const errors = validate(repo, mode, issue, description);
  const shown = showErrors ? errors : {};

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setShowErrors(true);
    if (Object.keys(errors).length > 0 || create.isPending) return;
    create.mutate(
      {
        repo: repo.trim(),
        workflow_ref: CODING_WORKFLOW_ID,
        ...(mode === 'issue' ? { issue_number: Number(issue.trim()) } : {}),
        // With an issue, the text box is optional extra guidance on top of the issue.
        ...(description.trim() ? { task_description: description.trim() } : {}),
      },
      { onSuccess: (task) => navigate(taskHref(task.task_id)) },
    );
  };

  return (
    <ContentLayout header={<Header variant="h1" description="Tell an agent what to do. It opens a pull request when it's done.">New task</Header>}>
      <form onSubmit={submit} noValidate>
        <Form
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" formAction="none" onClick={() => navigate(-1)}>Cancel</Button>
              <Button variant="primary" loading={create.isPending}>Start task</Button>
            </SpaceBetween>
          }
          errorText={create.isError ? submitError(create.error) : undefined}
        >
          <Container>
            <SpaceBetween size="l">
              <FormField label="Repository" description="The GitHub repository to work in." errorText={shown.repo}>
                <Autosuggest
                  value={repo}
                  options={knownRepos}
                  placeholder="owner/name"
                  enteredTextLabel={(value) => `Use "${value}"`}
                  empty="No repositories used yet"
                  onChange={({ detail }) => setRepo(detail.value)}
                />
              </FormField>

              <FormField label="What should it do?">
                <RadioGroup
                  value={mode}
                  onChange={({ detail }) => setMode(detail.value as Mode)}
                  items={[
                    { value: 'describe', label: 'Describe the change' },
                    { value: 'issue', label: 'Fix a GitHub issue' },
                  ]}
                />
              </FormField>

              {mode === 'issue' && (pickerAvailable ? (
                <FormField
                  label="Issue"
                  description={chosenIssue ? `#${chosenIssue.number}: ${chosenIssue.title}` : 'Pick an open issue, or type its number.'}
                  errorText={shown.issue}
                >
                  <Autosuggest
                    value={issue}
                    options={issueOptions}
                    placeholder={repoLooksValid ? 'Search open issues' : 'Choose a repository first'}
                    disabled={!repoLooksValid}
                    statusType={issues.isFetching ? 'loading' : issues.isError ? 'error' : 'finished'}
                    loadingText="Loading open issues"
                    errorText={issues.isError ? (issues.error instanceof Error ? issues.error.message : 'Could not load issues.') : undefined}
                    empty="No open issues in this repository"
                    enteredTextLabel={(value) => (/^#?\d+$/.test(value) ? `Use issue #${value.replace(/^#/, '')}` : `No issue matches "${value}"`)}
                    onChange={({ detail }) => setIssue(detail.value.replace(/^#/, ''))}
                    filteringType="auto"
                    data-testid="issue-picker"
                  />
                </FormField>
              ) : (
                <FormField label="Issue number" errorText={shown.issue}>
                  <Input value={issue} inputMode="numeric" placeholder="12" onChange={({ detail }) => setIssue(detail.value)} />
                </FormField>
              ))}

              <FormField
                label={mode === 'issue' ? 'Anything to add? (optional)' : 'Describe the change'}
                description={mode === 'issue'
                  ? 'Extra guidance on top of what the issue says.'
                  : 'Write it like you would for a teammate: what to change, and how you will know it is right.'}
                errorText={shown.description}
              >
                <Textarea
                  value={description}
                  rows={6}
                  placeholder={mode === 'issue' ? '' : 'Fix the off-by-one error in inBounds() and add a test for the map edge.'}
                  onChange={({ detail }) => setDescription(detail.value)}
                />
              </FormField>
            </SpaceBetween>
          </Container>
        </Form>
      </form>
    </ContentLayout>
  );
}
