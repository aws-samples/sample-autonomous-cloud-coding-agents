import React from 'react';
import { Box, Text } from 'ink';
import figures from 'figures';

interface Props { children: React.ReactNode; }
interface State { error: Error | null; }

class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

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
