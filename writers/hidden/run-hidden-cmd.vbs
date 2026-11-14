' Usage: wscript run-hidden-cmd.vbs "<path-to-cmd>" [args...]
' Launches the given .cmd in a hidden console window (no visible UI).
' Extra arguments are appended to the command line.
'
' Copied into <WK_INJECT_HOME>/bin by writers/register-tasks.ps1, which is what the
' scheduled tasks point at. wscript.exe is a GUI subsystem program, so starting it
' never creates a console; Run(cmd, 0, False) then starts the console host hidden.
If WScript.Arguments.Count = 0 Then
    WScript.Quit 1
End If
line = WScript.Arguments(0)
For i = 1 To WScript.Arguments.Count - 1
    line = line & " " & WScript.Arguments(i)
Next
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd.exe /c """ & line & """", 0, False
