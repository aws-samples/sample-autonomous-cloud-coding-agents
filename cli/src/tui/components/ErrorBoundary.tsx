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

import figures from 'figures';
import { Box, Text } from 'ink';
import React from 'react';

interface Props { children: React.ReactNode }
interface State { error: Error | null }

class ErrorBoundary extends React.Component<Props, State> {
  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  state: State = { error: null };

  render() {
    if (this.state.error) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color="red" bold>{figures.cross} Something went wrong</Text>
          <Text> </Text>
          <Text color="red">{this.state.error.message}</Text>
          <Text dimColor>{this.state.error.stack?.split('\n').slice(1, 4).join('\n')}</Text>
          <Text> </Text>
          <Text dimColor>Press Ctrl+C to exit, then restart with: npm run tui</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
