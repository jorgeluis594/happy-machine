# Install the happy-memory CLI

Use these steps only after a command fails because the `happy-memory` executable is missing or cannot be found on `PATH`.

## Linux and macOS

Install the latest stable release:

```sh
curl -fsSL https://raw.githubusercontent.com/jorgeluis594/happy-memory/main/install.sh | sh
```

To inspect the installer before running it:

```sh
curl -fsSLO https://raw.githubusercontent.com/jorgeluis594/happy-memory/main/install.sh
less install.sh
sh install.sh
```

The default installation directory is `~/.local/bin`. If the installer reports that this directory is not on `PATH`, follow its instructions and start a new shell before retrying.

## Windows

Install the latest stable release with Windows PowerShell 5.1 or PowerShell 7:

```powershell
irm https://raw.githubusercontent.com/jorgeluis594/happy-memory/main/install.ps1 | iex
```

To inspect the installer before running it:

```powershell
irm https://raw.githubusercontent.com/jorgeluis594/happy-memory/main/install.ps1 -OutFile install.ps1
Get-Content .\install.ps1
.\install.ps1
```

The default installation directory is `%LOCALAPPDATA%\Programs\happy-memory\bin`. The installer adds it to the user-level `PATH`; start a new shell before retrying if the current shell does not see the change.

## Verify the installation

Run:

```sh
happy-memory version
```

Continue with the skill only after this command succeeds.
