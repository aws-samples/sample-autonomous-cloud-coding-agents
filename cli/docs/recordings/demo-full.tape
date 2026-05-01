# Full TUI Demo — splash → all panels
# Run: vhs demo-full.tape

Output demo-full.gif
Set FontSize 14
Set Width 1200
Set Height 700
Set Padding 20

# Start the TUI
Type "npm run tui"
Enter
Sleep 3s

# Splash screen visible — press key to dismiss
Type " "
Sleep 1.5s

# Tasks panel — navigate list
Sleep 1s
Down
Sleep 0.5s
Down
Sleep 0.5s
Up
Sleep 1s

# Select first task → Watch
Enter
Sleep 3s

# Watch events streaming in...
Sleep 3s

# Scroll up through events
Up
Up
Up
Sleep 1s
# Scroll back down
Down
Down
Down
Sleep 1s

# Nudge the agent
Type "n"
Sleep 0.5s
Type "focus on the unit tests first"
Sleep 0.5s
Enter
Sleep 1.5s

# Switch to Approvals
Type "3"
Sleep 1.5s

# Drill into detail
Enter
Sleep 2s

# Approve
Type "a"
Sleep 1s

# Back to list
Escape
Sleep 1s

# Switch to Policies
Type "4"
Sleep 1s

# View a policy detail
Down
Down
Enter
Sleep 2s

# Navigate while detail stays open
Down
Sleep 1s
Down
Sleep 1s

# Close detail
Escape
Sleep 1s

# Switch to Submit (New Task)
Type "5"
Sleep 1s

# Select repo
Down
Sleep 0.5s
Enter
Sleep 0.5s

# Type instructions
Enter
Type "Add integration tests for the payment service"
Enter
Sleep 1s

# Submit
Down
Down
Down
Enter
Sleep 2s

# Quit
Type "q"
Sleep 0.5s
