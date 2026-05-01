# Watch panel — event streaming + inline approval + nudge
# Run: vhs demo-watch.tape

Output demo-watch.gif
Set FontSize 14
Set Width 1200
Set Height 700
Set Padding 20

Type "npm run tui"
Enter
Sleep 3s
Type " "
Sleep 1s

# Select a task
Enter
Sleep 5s

# Events streaming in...
Sleep 5s

# Scroll up through history
Up
Up
Up
Up
Sleep 2s

# Back to live
Down
Down
Down
Down
Sleep 2s

# Approve inline
Type "a"
Sleep 1.5s

# Nudge
Type "n"
Sleep 0.5s
Type "please add error handling"
Enter
Sleep 2s

# Back to tasks
Escape
Sleep 1s

Type "q"
