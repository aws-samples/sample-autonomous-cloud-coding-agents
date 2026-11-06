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

/**
 * Terminal presentation for `bgagent setup`: plain-language summaries of
 * `cdk diff` / `cdk deploy` output and a live progress board. Raw CDK output
 * goes to a log file; the operator sees components, counts and causes.
 */

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 100;
const BAR_WIDTH = 28;
const PERCENT = 100;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
/** Lines of raw output shown when a failure has no CloudFormation reason. */
const TAIL_LINES = 6;
/** Recent raw lines kept to find an error when CloudFormation gives none. */
const TAIL_BUFFER_LINES = 24;
/** Progress granularity when output is not a terminal. */
const PLAIN_STEPS = 10;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Component names shown to the operator, keyed by top-level construct id in `AgentStack`. */
const COMPONENTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Networking', ['AgentVpc', 'DnsFirewall']],
  ['Task API & sign-in', ['TaskApi']],
  ['Agent runtime', [
    'Runtime', 'RuntimeApplicationLogGroup', 'RuntimeUsageLogGroup', 'AgentMemory', 'AgentSessionRole', 'InputGuardrail',
    'CdkLogGroupLogsDeliveryPolicy', 'EcsAgentCluster', 'AgentImage', 'EcsPayloadBucket', 'LambdaMicrovmCompute',
  ]],
  ['Task data & storage', [
    'TaskTable', 'TaskEventsTable', 'TaskNudgesTable', 'TaskApprovalsTableV2', 'UserConcurrencyTable', 'BudgetTable',
    'WebhookTable', 'ApiKeyTable', 'RepoTable', 'OrchestrationTable', 'TraceArtifactsBucket', 'AttachmentsBucket',
    'GitHubTokenSecret', 'CedarWasmLayer',
  ]],
  ['Orchestration', [
    'TaskOrchestrator', 'ConcurrencyReconciler', 'AdmissionQueuePickup', 'StrandedTaskReconciler', 'PendingUploadCleanup',
    'OrchestrationReconciler', 'StrandedOrchestrationReconciler', 'IterationHeartbeat', 'FanOutConsumer',
    'ApprovalMetricsPublisherConsumer',
  ]],
  ['Monitoring & alerts', ['TaskDashboard', 'OperationalAlerts', 'BudgetAlerts', 'ModelInvocationLogGroup', 'BedrockLoggingRole', 'ModelInvocationLogging']],
  ['Slack', ['SlackIntegration']],
  ['Linear', ['LinearIntegration', 'LinearIdentityVault', 'LinearVaultConsentPageStack']],
  ['Jira', ['JiraIntegration']],
  ['Deploy-preview screenshots', ['GitHubScreenshotIntegration']],
  ['AWS Agent Registry', ['AgentRegistryStack', 'RegistryApi']],
  ['Tool Gateway', ['ToolGateway']],
];
const COMPONENT_BY_ID = new Map(COMPONENTS.flatMap(([name, ids]) => ids.map(id => [id, name] as const)));
export const COMPONENT_ORDER: readonly string[] = [...COMPONENTS.map(([name]) => name), 'Repository onboarding', 'Platform helpers'];

/** Map a construct path (with or without the stack prefix) to an operator-facing component. */
export function componentForPath(constructPath: string, stackNames: readonly string[]): string {
  let rest = constructPath;
  for (const stack of stackNames) {
    if (rest.startsWith(`${stack}/`)) {
      rest = rest.slice(stack.length + 1);
      break;
    }
  }
  // The split network stack owns only networking.
  if (stackNames.length > 1 && constructPath.startsWith(`${stackNames[1]}/`)) return 'Networking';
  const top = rest.split('/')[0].split('.')[0];
  if (COMPONENT_BY_ID.has(top)) return COMPONENT_BY_ID.get(top)!;
  if (top.endsWith('Blueprint')) return 'Repository onboarding';
  return 'Platform helpers';
}

/** `stack/SlackIntegration/EventsFn/Resource` → `SlackIntegration/EventsFn`. */
export function displayPath(constructPath: string, stackNames: readonly string[]): string {
  const stack = stackNames.find(name => constructPath.startsWith(`${name}/`));
  return (stack ? constructPath.slice(stack.length + 1) : constructPath).replace(/\/(Resource|Default)$/, '');
}

export interface DiffSummary {
  readonly create: number;
  readonly update: number;
  readonly remove: number;
  /** Changed resources per component, root stacks only (nested stacks count as one). */
  readonly perComponent: ReadonlyMap<string, number>;
  readonly iamResources: number;
}

/** Count resource changes in `cdk diff` output for the application (and network) stacks. */
export function summarizeDiff(output: string, stackNames: readonly string[]): DiffSummary {
  let create = 0;
  let update = 0;
  let remove = 0;
  let iamResources = 0;
  const perComponent = new Map<string, number>();
  let inRootStack = false;
  for (const raw of stripAnsi(output).split('\n')) {
    const header = /^Stack (\S+)/.exec(raw);
    if (header) {
      inRootStack = stackNames.includes(header[1]);
      continue;
    }
    if (!inRootStack) continue;
    const match = /^\[([-+~])\] (AWS::\S+|Custom::\S+) (\S+)/.exec(raw);
    if (!match) continue;
    const [, marker, type, constructPath] = match;
    if (marker === '+') create += 1;
    else if (marker === '~') update += 1;
    else remove += 1;
    if (type.startsWith('AWS::IAM::')) iamResources += 1;
    const component = componentForPath(constructPath, stackNames);
    perComponent.set(component, (perComponent.get(component) ?? 0) + 1);
  }
  return { create, update, remove, perComponent, iamResources };
}

export interface DeployEvent {
  readonly stack: string;
  readonly done?: number;
  readonly total?: number;
  readonly status: string;
  readonly type: string;
  readonly constructPath: string;
  readonly logicalId: string;
  readonly reason: string;
}

/** Parse one `cdk deploy --progress events` line. */
export function parseDeployEvent(line: string): DeployEvent | undefined {
  const match = /^(\S+) \| (?:\s*(\d+)\/(\d+) \| )?[^|]+\| ([A-Z_]+(?: \(skipped\))?)\s*\| (\S+)\s*\| (\S+)(?: \(([^)]+)\))?\s*(.*)$/.exec(stripAnsi(line).trimEnd());
  if (!match) return undefined;
  const [, stack, done, total, status, type, constructPath, logicalId, reason] = match;
  return {
    stack,
    ...(done !== undefined ? { done: Number(done), total: Number(total) } : {}),
    status: status.trim(),
    type,
    constructPath,
    logicalId: logicalId ?? constructPath,
    reason: reason.trim(),
  };
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / MS_PER_SECOND);
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  return minutes > 0 ? `${minutes}m ${seconds % SECONDS_PER_MINUTE}s` : `${seconds}s`;
}

/** Minimal styling; colour only on a TTY that has not opted out. */
export class Style {
  constructor(private readonly color: boolean) {}
  private wrap(code: string, text: string): string {
    return this.color ? `\u001b[${code}m${text}\u001b[0m` : text;
  }
  bold(text: string): string { return this.wrap('1', text); }
  dim(text: string): string { return this.wrap('2', text); }
  green(text: string): string { return this.wrap('32', text); }
  red(text: string): string { return this.wrap('31', text); }
  yellow(text: string): string { return this.wrap('33', text); }
  cyan(text: string): string { return this.wrap('36', text); }
}

export interface Screen {
  readonly tty: boolean;
  readonly write: (text: string) => void;
}

/**
 * A redrawable block of lines. On a TTY it repaints in place with a spinner;
 * elsewhere it prints only lines that changed, so CI logs stay readable.
 */
export class LiveBlock {
  private frame = 0;
  private drawn = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private printed = new Set<string>();

  constructor(private readonly screen: Screen, private readonly render: (spinner: string) => string[]) {
    if (screen.tty) {
      this.timer = setInterval(() => this.paint(), SPINNER_INTERVAL_MS);
      this.timer.unref?.();
    }
    this.paint();
  }

  paint(): void {
    const lines = this.render(SPINNER_FRAMES[this.frame++ % SPINNER_FRAMES.length]);
    if (this.screen.tty) {
      const clear = this.drawn > 0 ? `\u001b[${this.drawn}A\u001b[0J` : '';
      this.screen.write(`${clear}${lines.join('\n')}\n`);
      this.drawn = lines.length;
      return;
    }
    for (const line of lines.map(stripAnsi)) {
      // Spinner frames would make every repaint "new"; compare without them.
      const key = line.replace(new RegExp(`[${SPINNER_FRAMES.join('')}]`, 'g'), '·');
      if (!this.printed.has(key)) {
        this.printed.add(key);
        this.screen.write(`${key}\n`);
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.paint();
  }
}

/** One spinner line that resolves to ✓ or ✗. */
export class Step {
  private state: 'running' | 'ok' | 'failed' = 'running';
  private detail = '';
  private readonly block: LiveBlock;

  constructor(screen: Screen, private readonly style: Style, private readonly label: string) {
    this.block = new LiveBlock(screen, spinner => [this.line(spinner)]);
  }

  private line(spinner: string): string {
    const mark = this.state === 'ok' ? this.style.green('✓') : this.state === 'failed' ? this.style.red('✗') : this.style.cyan(spinner);
    return `  ${mark} ${this.label}${this.detail ? this.style.dim(`  ${this.detail}`) : ''}`;
  }

  succeed(detail = ''): void {
    this.state = 'ok';
    this.detail = detail;
    this.block.stop();
  }

  fail(detail = ''): void {
    this.state = 'failed';
    this.detail = detail;
    this.block.stop();
  }
}

export interface DeployFailure {
  readonly component: string;
  readonly resource: string;
  readonly status: string;
  readonly reason: string;
}

/**
 * Live view of a `cdk deploy`: preparation (synth, image build, asset
 * publishing), an overall bar, and one line per component with its own count.
 */
export class DeployProgress {
  private phase: 'preparing' | 'deploying' | 'done' | 'failed' = 'preparing';
  private overall = { done: 0, total: 0 };
  private readonly finished = new Map<string, Set<string>>();
  private readonly started = new Set<string>();
  private readonly failures: DeployFailure[] = [];
  private readonly tail: string[] = [];
  private readonly block: LiveBlock;
  private readonly tty: boolean;

  constructor(
    screen: Screen,
    private readonly style: Style,
    private readonly stackNames: readonly string[],
    private readonly expected: ReadonlyMap<string, number>,
  ) {
    this.tty = screen.tty;
    this.block = new LiveBlock(screen, spinner => this.lines(spinner));
  }

  handleLine(raw: string): void {
    const line = stripAnsi(raw).trimEnd();
    if (!line.trim()) return;
    this.tail.push(line);
    if (this.tail.length > TAIL_BUFFER_LINES) this.tail.shift();
    const event = parseDeployEvent(line);
    if (!event || !this.stackNames.includes(event.stack)) return;
    if (this.phase === 'preparing') this.phase = 'deploying';
    if (event.total !== undefined) this.overall = { done: event.done!, total: event.total };
    // Stack-level events describe the whole deployment, not a component.
    if (event.type === 'AWS::CloudFormation::Stack' && this.stackNames.includes(event.logicalId)) return;
    const component = componentForPath(event.constructPath, this.stackNames);
    this.started.add(component);
    if (/_FAILED$/.test(event.status) && !/cancelled/i.test(event.reason)) {
      this.failures.push({ component, resource: displayPath(event.constructPath, this.stackNames), status: event.status, reason: event.reason });
    }
    if (/_COMPLETE$/.test(event.status) && !/ROLLBACK/.test(event.status)) {
      const set = this.finished.get(component) ?? new Set<string>();
      set.add(event.logicalId);
      this.finished.set(component, set);
    }
    this.block.paint();
  }

  finish(ok: boolean): { failures: readonly DeployFailure[]; tail: readonly string[] } {
    this.phase = ok ? 'done' : 'failed';
    this.block.stop();
    return { failures: this.failures, tail: this.tail.slice(-TAIL_LINES) };
  }

  private lines(spinner: string): string[] {
    const { style } = this;
    const prepMark = this.phase === 'preparing' ? style.cyan(spinner) : this.phase === 'failed' && this.overall.total === 0
      ? style.red('✗') : style.green('✓');
    const lines = [`  ${prepMark} Preparing deployment ${style.dim('(building the agent image)')}`];
    if (this.phase === 'preparing') return lines;
    const exact = this.overall.total > 0 ? Math.min(1, this.overall.done / this.overall.total) : 0;
    // Without a TTY every repaint is a new line; report in 10% steps instead.
    const ratio = this.phase === 'done' ? 1 : this.tty ? exact : Math.floor(exact * PLAIN_STEPS) / PLAIN_STEPS;
    const filled = Math.round(ratio * BAR_WIDTH);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;
    lines.push(`  ${this.phase === 'done' ? style.green('✓') : this.phase === 'failed' ? style.red('✗') : style.cyan(spinner)} Deploying  ${bar} `
      + `${Math.round(ratio * PERCENT)}%${this.tty ? `  ${style.dim(`${this.overall.done}/${this.overall.total}`)}` : ''}`);
    for (const component of COMPONENT_ORDER) {
      const total = this.expected.get(component) ?? 0;
      const done = this.finished.get(component)?.size ?? 0;
      if (total === 0 && done === 0) continue;
      const failed = this.failures.some(failure => failure.component === component);
      const complete = this.phase === 'done' || (total > 0 && done >= total);
      const mark = failed ? style.red('✗') : complete ? style.green('✓')
        : this.started.has(component) ? style.cyan(spinner) : style.dim('○');
      const count = complete || !this.tty ? '' : style.dim(`  ${Math.min(done, total || done)}/${total || '?'}`);
      lines.push(`      ${mark} ${component}${count}`);
    }
    return lines;
  }
}
