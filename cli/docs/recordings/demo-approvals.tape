# Approval flow — list → detail → approve/deny
# Run: vhs demo-approvals.tape

Output demo-approvals.gif
Set FontSize 14
Set Width 1200
Set Height 700
Set Padding 20

Type "npm run tui"
Enter
Sleep 3s
Type " "
Sleep 1s

# Go to Approvals
Type "3"
Sleep 1.5s

# Browse approvals
Down
Sleep 0.5s
Up
Sleep 1s

# Drill into detail
Enter
Sleep 3s

# Deny with confirmation
Type "d"
Sleep 1s
# See the confirm dialog
Sleep 1.5s
# Cancel
Type "n"
Sleep 1s

# Approve instead
Type "a"
Sleep 1.5s

# Back to list
Escape
Sleep 1s

Type "q"
