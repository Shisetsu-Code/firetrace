"""Windows configuration and quiet subprocess defaults for the desktop worker."""
from __future__ import annotations

import os
import subprocess

CONFIG_NAMES = (
    'CF_CONTROL_URL', 'CF_CONTROL_TOKEN', 'FIRETRACE_CONTROL_URL',
    'FIRETRACE_CONTROL_TOKEN', 'FIRETRACE_AGENT_ID', 'FIRETRACE_CDP_URL',
    'FIRETRACE_BROWSER_BACKEND', 'FIRETRACE_TRANSPORT',
    'FIRETRACE_MCP_HOST', 'FIRETRACE_MCP_PORT',
)


def load_user_environment() -> None:
    """Explorer can retain an old environment after configuration was saved."""
    if os.name != 'nt':
        return
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment') as key:
            for name in CONFIG_NAMES:
                if os.environ.get(name):
                    continue
                try:
                    value, _ = winreg.QueryValueEx(key, name)
                except FileNotFoundError:
                    continue
                if isinstance(value, str) and value:
                    os.environ[name] = value
    except FileNotFoundError:
        pass


def quiet_process_options() -> dict:
    options = {'stdin': subprocess.DEVNULL}
    if os.name == 'nt':
        options['creationflags'] = subprocess.CREATE_NO_WINDOW
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = subprocess.SW_HIDE
        options['startupinfo'] = startup
    return options


def git_environment() -> dict:
    return {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GCM_INTERACTIVE': 'Never'}
