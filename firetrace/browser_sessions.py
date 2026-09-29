"""Owned, independent Chromium processes; the agent outlives every window."""
from __future__ import annotations

import os
import re
import uuid
from pathlib import Path

from playwright.sync_api import sync_playwright, Error

from .local_browser import LocalBrowserBackend
from .runtime import configure_browser_cache


class BrowserSessions(LocalBrowserBackend):
    def __init__(self, *, profile_root=None, max_browsers=None):
        self.max_browsers = int(max_browsers or os.getenv('FIRETRACE_MAX_BROWSERS', '4'))
        if not 1 <= self.max_browsers <= 32:
            raise ValueError('FIRETRACE_MAX_BROWSERS must be between 1 and 32')
        self.profile_root = Path(profile_root or os.getenv('FIRETRACE_PROFILE_DIR') or
                                 Path(os.getenv('LOCALAPPDATA', str(Path.home() / '.local/share'))) / 'Firetrace' / 'profiles')
        self._sessions = {}
        self._selected = None
        configure_browser_cache()
        self._pw = sync_playwright().start()

    @property
    def browser(self):
        return self._sessions[self._selected]['browser']

    @property
    def context(self):
        return self._sessions[self._selected]['context']

    @property
    def page(self):
        record = self._sessions[self._selected]
        page = record['page']
        if page.is_closed():
            pages = record['context'].pages
            if not pages:
                raise ValueError('Browser window closed; use browser_reopen')
            record['page'] = page = pages[0]
        return page

    def _live(self, record):
        browser = record.get('browser')
        if not browser or not browser.is_connected():
            return False
        try:
            # A protocol round trip also delivers queued manual-close events to
            # Playwright's synchronous dispatcher. No cookie data is returned.
            record['context'].cookies()
            return bool(record['context'].pages)
        except Error:
            return False

    def _describe(self, record):
        live = self._live(record)
        pages = record['context'].pages if live else []
        return {'browser_id': record['id'], 'mode': record['mode'],
                'profile': record['profile'], 'open': live,
                'pages': len(pages), 'urls': [page.url for page in pages]}

    def list_browsers(self):
        browsers = [self._describe(record) for record in self._sessions.values()]
        profiles = sorted(path.name for path in self.profile_root.glob('*')
                          if path.is_dir() and not path.is_symlink()) if self.profile_root.exists() else []
        return {'browsers': browsers, 'profiles': profiles,
                'active_count': sum(item['open'] for item in browsers), 'max_browsers': self.max_browsers}

    def status(self):
        return {'backend': 'local-playwright-sessions', 'connected': True, **self.list_browsers()}

    @staticmethod
    def _validate_profile(profile):
        if not isinstance(profile, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', profile):
            raise ValueError('profile must be a lowercase identifier, 1-64 characters')
        if profile in {'con', 'prn', 'aux', 'nul', *(f'com{i}' for i in range(10)), *(f'lpt{i}' for i in range(10))}:
            raise ValueError('Reserved profile name')

    def create(self, mode='temporary', profile=None):
        if mode not in ('temporary', 'persistent'):
            raise ValueError('mode must be temporary or persistent')
        if mode == 'persistent':
            self._validate_profile(profile)
            for record in self._sessions.values():
                if record['profile'] == profile:
                    if self._live(record):
                        raise ValueError('Persistent profile is already open: ' + record['id'])
                    return self.reopen(record['id'])
        elif profile is not None:
            raise ValueError('profile is only valid for persistent sessions')
        record = {'id': uuid.uuid4().hex, 'mode': mode, 'profile': profile}
        self._launch(record)
        self._sessions[record['id']] = record
        return self._describe(record)

    def _launch(self, record):
        if self.list_browsers()['active_count'] >= self.max_browsers:
            raise ValueError(f'Browser limit reached ({self.max_browsers}); close a window first')
        headless = os.getenv('FIRETRACE_HEADLESS', '0') == '1'
        if record['mode'] == 'persistent':
            self.profile_root.mkdir(parents=True, exist_ok=True)
            path = self.profile_root / record['profile']
            if path.resolve().parent != self.profile_root.resolve() or path.is_symlink():
                raise ValueError('Invalid profile directory')
            context = self._pw.chromium.launch_persistent_context(str(path), headless=headless)
            browser = context.browser
        else:
            browser = self._pw.chromium.launch(headless=headless)
            try:
                context = browser.new_context()
            except Exception:
                browser.close()
                raise
        try:
            page = context.pages[0] if context.pages else context.new_page()
        except Exception:
            browser.close()
            raise
        record.update(browser=browser, context=context, page=page)

    def _record(self, browser_id):
        if browser_id not in self._sessions:
            raise ValueError('Unknown browser_id; use browser_list')
        return self._sessions[browser_id]

    def close_browser(self, browser_id):
        record = self._record(browser_id)
        browser = record.get('browser')
        if browser and browser.is_connected():
            record['context'].close()
            browser.close()
        return self._describe(record)

    def reopen(self, browser_id):
        record = self._record(browser_id)
        if self._live(record):
            return self._describe(record)
        self.close_browser(browser_id)
        self._launch(record)
        return self._describe(record)

    def select(self, browser_id=None, *, allow_create=False):
        if browser_id is None:
            live = [r for r in self._sessions.values() if self._live(r)]
            if len(live) == 1:
                browser_id = live[0]['id']
            elif len(live) > 1:
                raise ValueError('Multiple windows open; specify browser_id from browser_list')
            elif allow_create and len(self._sessions) <= 1:
                browser_id = (self.reopen(next(iter(self._sessions))) if self._sessions else self.create())['browser_id']
            else:
                raise ValueError('No open window; specify browser_id or use browser_create/browser_reopen')
        record = self._record(browser_id)
        if not self._live(record):
            raise ValueError('Browser window closed; use browser_reopen with this browser_id')
        self._selected = browser_id
        return browser_id

    def close(self):
        try:
            for browser_id in self._sessions:
                try:
                    self.close_browser(browser_id)
                except Error:
                    pass
        finally:
            self._pw.stop()
