// tests/local_runner.test.js — vitest для lib/local_runner.js.
//
// Покрытие:
//   - matchCondition: каждое поле + оператор;
//   - matchRule: allof/anyof;
//   - applyActions: через моки browser.messages.*;
//   - runRuleOnFolder: пагинация, прогресс, abort, summary, skipped redirect.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  matchCondition,
  matchRule,
  applyActions,
  runRuleOnFolder,
  findFolderByPath,
  findTrashFolder,
  needFullMessage,
} from '../lib/local_runner.js';

// ────────────────────────────────────────────────────────────────────────────
// Helpers: mock browser API
// ────────────────────────────────────────────────────────────────────────────
function makeMockBrowser({ pages = [], totalCount = null, getFullByMsg = {} } = {}) {
  const calls = {
    move: [],
    copy: [],
    update: [],
    del: [],
    getFull: [],
    list: [],
    continueList: [],
    getFolderInfo: [],
  };
  const messages = {
    list: vi.fn(async (folderId) => {
      calls.list.push(folderId);
      // pages: [{messages:[...], id:'p2'}, {messages:[...], id:null}]
      return pages[0] || { messages: [], id: null };
    }),
    continueList: vi.fn(async (id) => {
      calls.continueList.push(id);
      const idx = pages.findIndex(p => p.id === id);
      // Возвращаем СЛЕДУЮЩУЮ страницу за p (а не p сама).
      // pages представлены так, что page[i].id указывает на page[i+1] логически,
      // но в этом моке считаем что continueList(p.id) → p (та же), и переход
      // идёт через _index. Перепишем: будем использовать stateful counter.
      throw new Error('continueList not configured for this test');
    }),
    getFull: vi.fn(async (id) => {
      calls.getFull.push(id);
      return getFullByMsg[id] || { headers: {}, parts: [] };
    }),
    move: vi.fn(async (ids, destId) => { calls.move.push({ ids, destId }); }),
    copy: vi.fn(async (ids, destId) => { calls.copy.push({ ids, destId }); }),
    update: vi.fn(async (id, props) => { calls.update.push({ id, props }); }),
    delete: vi.fn(async (ids, perm) => { calls.del.push({ ids, perm }); }),
  };
  const folders = {
    getFolderInfo: vi.fn(async (folderId) => {
      calls.getFolderInfo.push(folderId);
      if (totalCount == null) throw new Error('no total');
      return { totalMessageCount: totalCount };
    }),
  };
  return { messages, folders, calls };
}

// Stateful pagination helper.
function makePagedBrowser(allMessages, pageSize = 2) {
  const pages = [];
  for (let i = 0; i < allMessages.length; i += pageSize) {
    const slice = allMessages.slice(i, i + pageSize);
    const isLast = i + pageSize >= allMessages.length;
    pages.push({ messages: slice, id: isLast ? null : `page-${i + pageSize}` });
  }
  if (pages.length === 0) pages.push({ messages: [], id: null });

  const calls = {
    move: [], copy: [], update: [], del: [], getFull: [],
    list: [], continueList: [], getFolderInfo: [],
  };
  let pageIdx = 0;
  const messages = {
    list: vi.fn(async (folderId) => {
      calls.list.push(folderId);
      pageIdx = 1;
      return pages[0];
    }),
    continueList: vi.fn(async (id) => {
      calls.continueList.push(id);
      const p = pages[pageIdx++];
      if (!p) return { messages: [], id: null };
      return p;
    }),
    getFull: vi.fn(async (id) => {
      calls.getFull.push(id);
      return { headers: {}, parts: [] };
    }),
    move: vi.fn(async (ids, destId) => { calls.move.push({ ids, destId }); }),
    copy: vi.fn(async (ids, destId) => { calls.copy.push({ ids, destId }); }),
    update: vi.fn(async (id, props) => { calls.update.push({ id, props }); }),
    delete: vi.fn(async (ids, perm) => { calls.del.push({ ids, perm }); }),
  };
  const folders = {
    getFolderInfo: vi.fn(async () => ({ totalMessageCount: allMessages.length })),
  };
  return { messages, folders, calls };
}

// ────────────────────────────────────────────────────────────────────────────
// matchCondition tests
// ────────────────────────────────────────────────────────────────────────────
describe('matchCondition — text fields', () => {
  const baseMsg = {
    id: 1,
    author: 'Alice <alice@example.com>',
    recipients: ['bob@example.com', 'carol@example.com'],
    ccList: ['dave@example.com'],
    subject: 'Hello world from Mailcow',
    size: 4096,
  };

  it('from contains', () => {
    expect(matchCondition({ field: 'from', op: 'contains', value: 'alice' }, baseMsg)).toBe(true);
    expect(matchCondition({ field: 'from', op: 'contains', value: 'eve' }, baseMsg)).toBe(false);
  });
  it('from contains case-insensitive', () => {
    expect(matchCondition({ field: 'from', op: 'contains', value: 'ALICE' }, baseMsg)).toBe(true);
  });
  it('from not_contains', () => {
    expect(matchCondition({ field: 'from', op: 'not_contains', value: 'eve' }, baseMsg)).toBe(true);
    expect(matchCondition({ field: 'from', op: 'not_contains', value: 'alice' }, baseMsg)).toBe(false);
  });
  it('from is — точное совпадение строки', () => {
    expect(matchCondition({ field: 'from', op: 'is', value: 'Alice <alice@example.com>' }, baseMsg)).toBe(true);
    expect(matchCondition({ field: 'from', op: 'is', value: 'alice@example.com' }, baseMsg)).toBe(false);
  });
  it('to contains (массив recipients)', () => {
    expect(matchCondition({ field: 'to', op: 'contains', value: 'bob' }, baseMsg)).toBe(true);
    expect(matchCondition({ field: 'to', op: 'contains', value: 'carol' }, baseMsg)).toBe(true);
    expect(matchCondition({ field: 'to', op: 'contains', value: 'eve' }, baseMsg)).toBe(false);
  });
  it('cc contains', () => {
    expect(matchCondition({ field: 'cc', op: 'contains', value: 'dave' }, baseMsg)).toBe(true);
    expect(matchCondition({ field: 'cc', op: 'contains', value: 'eve' }, baseMsg)).toBe(false);
  });
  it('subject contains', () => {
    expect(matchCondition({ field: 'subject', op: 'contains', value: 'Mailcow' }, baseMsg)).toBe(true);
    expect(matchCondition({ field: 'subject', op: 'contains', value: 'Postfix' }, baseMsg)).toBe(false);
  });
  it('subject starts', () => {
    expect(matchCondition({ field: 'subject', op: 'starts', value: 'Hello' }, baseMsg)).toBe(true);
    expect(matchCondition({ field: 'subject', op: 'starts', value: 'world' }, baseMsg)).toBe(false);
  });
  it('subject ends', () => {
    expect(matchCondition({ field: 'subject', op: 'ends', value: 'Mailcow' }, baseMsg)).toBe(true);
    expect(matchCondition({ field: 'subject', op: 'ends', value: 'Hello' }, baseMsg)).toBe(false);
  });
  it('subject contains_any (массив)', () => {
    expect(matchCondition({ field: 'subject', op: 'contains_any', value: ['Postfix', 'Mailcow'] }, baseMsg)).toBe(true);
    expect(matchCondition({ field: 'subject', op: 'contains_any', value: ['Postfix', 'Exim'] }, baseMsg)).toBe(false);
  });
  it('subject contains_any (single value не-массив)', () => {
    expect(matchCondition({ field: 'subject', op: 'contains_any', value: 'world' }, baseMsg)).toBe(true);
  });
});

describe('matchCondition — header field (нужен full)', () => {
  const msg = { id: 7, author: 'x', subject: 's', size: 0 };
  const full = { headers: { 'list-id': ['<weekly.example.com>'], 'x-mailer': ['mutt'] } };

  it('header contains — ключ кейс-инсенситив', () => {
    expect(matchCondition(
      { field: 'header', headerName: 'List-Id', op: 'contains', value: 'weekly' },
      msg, full
    )).toBe(true);
    expect(matchCondition(
      { field: 'header', headerName: 'list-id', op: 'contains', value: 'monthly' },
      msg, full
    )).toBe(false);
  });
  it('header без full → false (не падает)', () => {
    expect(matchCondition(
      { field: 'header', headerName: 'X-Mailer', op: 'contains', value: 'mutt' },
      msg
    )).toBe(false);
  });
  it('header is', () => {
    expect(matchCondition(
      { field: 'header', headerName: 'X-Mailer', op: 'is', value: 'mutt' },
      msg, full
    )).toBe(true);
  });
  it('header не существует → false', () => {
    expect(matchCondition(
      { field: 'header', headerName: 'X-Nope', op: 'contains', value: 'x' },
      msg, full
    )).toBe(false);
  });
});

describe('matchCondition — size', () => {
  it('size gt KB', () => {
    expect(matchCondition({ field: 'size', op: 'gt', value: 5, unit: 'KB' }, { size: 10000 })).toBe(true); // 5*1024=5120 < 10000
    expect(matchCondition({ field: 'size', op: 'gt', value: 5, unit: 'KB' }, { size: 1000 })).toBe(false);
  });
  it('size lt KB', () => {
    expect(matchCondition({ field: 'size', op: 'lt', value: 5, unit: 'KB' }, { size: 1000 })).toBe(true);
    expect(matchCondition({ field: 'size', op: 'lt', value: 5, unit: 'KB' }, { size: 6000 })).toBe(false);
  });
  it('size gt MB', () => {
    expect(matchCondition({ field: 'size', op: 'gt', value: 1, unit: 'MB' }, { size: 2 * 1024 * 1024 })).toBe(true);
    expect(matchCondition({ field: 'size', op: 'gt', value: 1, unit: 'MB' }, { size: 1024 })).toBe(false);
  });
  it('size без unit → KB по умолчанию', () => {
    expect(matchCondition({ field: 'size', op: 'gt', value: 1 }, { size: 2048 })).toBe(true);
  });
});

describe('matchCondition — attachment', () => {
  const msg = { id: 1, size: 0 };

  it('has_attachment с msg.hasAttachment=true', () => {
    expect(matchCondition({ field: 'attachment', op: 'has_attachment' },
      { ...msg, hasAttachment: true })).toBe(true);
  });
  it('no_attachment с msg.hasAttachment=false', () => {
    expect(matchCondition({ field: 'attachment', op: 'no_attachment' },
      { ...msg, hasAttachment: false })).toBe(true);
  });
  it('has_attachment через full.parts с image/jpeg', () => {
    const full = {
      parts: [
        { contentType: 'multipart/mixed', parts: [
          { contentType: 'text/plain', partName: '1' },
          { contentType: 'image/jpeg', partName: '2', name: 'cat.jpg' },
        ]},
      ],
    };
    expect(matchCondition({ field: 'attachment', op: 'has_attachment' }, msg, full)).toBe(true);
    expect(matchCondition({ field: 'attachment', op: 'no_attachment' }, msg, full)).toBe(false);
  });
  it('no_attachment когда только text/plain в parts', () => {
    const full = {
      parts: [{ contentType: 'text/plain', partName: '1' }],
    };
    expect(matchCondition({ field: 'attachment', op: 'no_attachment' }, msg, full)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// matchRule
// ────────────────────────────────────────────────────────────────────────────
describe('matchRule — allof / anyof', () => {
  const msg = {
    id: 1, author: 'alice@x', subject: 'foo', size: 1000,
    recipients: ['bob@y'], ccList: [],
  };

  it('allof — все условия true', () => {
    const rule = {
      matchAll: true,
      conditions: [
        { field: 'from', op: 'contains', value: 'alice' },
        { field: 'subject', op: 'is', value: 'foo' },
      ],
    };
    expect(matchRule(rule, msg)).toBe(true);
  });
  it('allof — одно false → false', () => {
    const rule = {
      matchAll: true,
      conditions: [
        { field: 'from', op: 'contains', value: 'alice' },
        { field: 'subject', op: 'is', value: 'bar' },
      ],
    };
    expect(matchRule(rule, msg)).toBe(false);
  });
  it('anyof — одно true → true', () => {
    const rule = {
      matchAll: false,
      conditions: [
        { field: 'from', op: 'contains', value: 'eve' },
        { field: 'subject', op: 'is', value: 'foo' },
      ],
    };
    expect(matchRule(rule, msg)).toBe(true);
  });
  it('anyof — все false → false', () => {
    const rule = {
      matchAll: false,
      conditions: [
        { field: 'from', op: 'contains', value: 'eve' },
        { field: 'subject', op: 'is', value: 'bar' },
      ],
    };
    expect(matchRule(rule, msg)).toBe(false);
  });
  it('пустые conditions → false', () => {
    expect(matchRule({ conditions: [] }, msg)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// findFolderByPath / findTrashFolder
// ────────────────────────────────────────────────────────────────────────────
describe('findFolderByPath', () => {
  const folders = [
    { id: 'fid-inbox', name: 'INBOX', path: '/INBOX' },
    { id: 'fid-logistics', name: 'Logistics', path: '/INBOX/Logistics' },
    { id: 'fid-utf', name: 'Рассылка', path: '/INBOX/&BCAEMARBBEEESwQ7BDoEMA-' },
  ];
  it('точный path с /', () => {
    expect(findFolderByPath(folders, '/INBOX/Logistics')?.id).toBe('fid-logistics');
  });
  it('path без leading /', () => {
    expect(findFolderByPath(folders, 'INBOX/Logistics')?.id).toBe('fid-logistics');
  });
  it('decoded UTF-7 совпадает с raw (decoded path в правиле)', () => {
    // decodeIMAPUTF7('/INBOX/&BCAEMARBBEEESwQ7BDoEMA-') === '/INBOX/Рассылка'
    expect(findFolderByPath(folders, 'INBOX/Рассылка')?.id).toBe('fid-utf');
  });
  it('не найдено → null', () => {
    expect(findFolderByPath(folders, 'INBOX/Nope')).toBeNull();
  });
  it('пустой path → null', () => {
    expect(findFolderByPath(folders, '')).toBeNull();
  });
});

describe('findTrashFolder', () => {
  it('по specialUse=array', () => {
    const f = findTrashFolder([{ id: 't', specialUse: ['trash'] }, { id: 'i' }]);
    expect(f.id).toBe('t');
  });
  it('по type=trash', () => {
    const f = findTrashFolder([{ id: 'a' }, { id: 't', type: 'trash' }]);
    expect(f.id).toBe('t');
  });
  it('по имени Trash fallback', () => {
    const f = findTrashFolder([{ id: 'i', name: 'Inbox', path: '/Inbox' }, { id: 't', name: 'Trash', path: '/Trash' }]);
    expect(f.id).toBe('t');
  });
  it('нет trash → null', () => {
    expect(findTrashFolder([{ id: 'i', name: 'Inbox' }])).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// needFullMessage
// ────────────────────────────────────────────────────────────────────────────
describe('needFullMessage', () => {
  it('header → true', () => {
    expect(needFullMessage({ conditions: [{ field: 'header', headerName: 'X', op: 'contains', value: 'a' }] })).toBe(true);
  });
  it('attachment → true', () => {
    expect(needFullMessage({ conditions: [{ field: 'attachment', op: 'has_attachment' }] })).toBe(true);
  });
  it('только from/subject → false', () => {
    expect(needFullMessage({ conditions: [
      { field: 'from', op: 'contains', value: 'a' },
      { field: 'subject', op: 'is', value: 'b' },
    ] })).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// applyActions
// ────────────────────────────────────────────────────────────────────────────
describe('applyActions', () => {
  let mock;
  beforeEach(() => {
    mock = makeMockBrowser();
    vi.stubGlobal('browser', { messages: mock.messages, folders: mock.folders });
  });

  it('fileinto → messages.move с правильным folderId', async () => {
    const folders = [{ id: 'dst-id', name: 'X', path: '/INBOX/X' }];
    const r = await applyActions(
      { actions: [{ type: 'fileinto', folder: '/INBOX/X' }] },
      { id: 42 },
      { folders },
    );
    expect(r.applied).toEqual(['fileinto']);
    expect(mock.calls.move).toEqual([{ ids: [42], destId: 'dst-id' }]);
  });
  it('fileinto: folder не найдена → ошибка, без move', async () => {
    const r = await applyActions(
      { actions: [{ type: 'fileinto', folder: '/nope' }] },
      { id: 42 },
      { folders: [] },
    );
    expect(r.applied).toEqual([]);
    expect(r.errors.length).toBe(1);
    expect(mock.calls.move.length).toBe(0);
  });
  it('copy → messages.copy', async () => {
    const folders = [{ id: 'dst', path: '/X' }];
    await applyActions(
      { actions: [{ type: 'copy', folder: '/X' }] },
      { id: 1 },
      { folders },
    );
    expect(mock.calls.copy).toEqual([{ ids: [1], destId: 'dst' }]);
  });
  it('mark_read → messages.update read=true', async () => {
    await applyActions(
      { actions: [{ type: 'mark_read' }] },
      { id: 5 },
      { folders: [] },
    );
    expect(mock.calls.update).toEqual([{ id: 5, props: { read: true } }]);
  });
  it('flag → messages.update flagged=true', async () => {
    await applyActions(
      { actions: [{ type: 'flag' }] },
      { id: 6 },
      { folders: [] },
    );
    expect(mock.calls.update).toEqual([{ id: 6, props: { flagged: true } }]);
  });
  it('trash с явной trash папкой → move в неё', async () => {
    const folders = [{ id: 'tid', name: 'Trash', specialUse: ['trash'] }];
    await applyActions(
      { actions: [{ type: 'trash' }] },
      { id: 9 },
      { folders },
    );
    expect(mock.calls.move).toEqual([{ ids: [9], destId: 'tid' }]);
  });
  it('trash без trash папки → fallback на messages.delete', async () => {
    await applyActions(
      { actions: [{ type: 'trash' }] },
      { id: 10 },
      { folders: [] },
    );
    expect(mock.calls.del).toEqual([{ ids: [10], perm: false }]);
  });
  it('discard → messages.delete (skipTrash=false)', async () => {
    await applyActions(
      { actions: [{ type: 'discard' }] },
      { id: 11 },
      { folders: [] },
    );
    expect(mock.calls.del).toEqual([{ ids: [11], perm: false }]);
  });
  it('tag → messages.update tags=[merged keywords] (без существующих)', async () => {
    const r = await applyActions(
      { actions: [{ type: 'tag', keywords: ['$label1', '$label3'] }] },
      { id: 7 },
      { folders: [] },
    );
    expect(r.applied).toEqual(['tag']);
    expect(mock.calls.update).toEqual([{ id: 7, props: { tags: ['$label1', '$label3'] } }]);
  });
  it('tag → сливает с msg.tags, не теряя дубликатов и существующих', async () => {
    await applyActions(
      { actions: [{ type: 'tag', keywords: ['$label1', '$label3'] }] },
      { id: 8, tags: ['$label1', '$other'] },
      { folders: [] },
    );
    // существующее $label1 не должно быть продублировано;
    // $other сохраняется; $label3 добавляется.
    const last = mock.calls.update[mock.calls.update.length - 1];
    expect(last.id).toBe(8);
    expect(new Set(last.props.tags)).toEqual(new Set(['$label1', '$other', '$label3']));
  });
  it('tag с пустым keywords — не падает, applied записан', async () => {
    const r = await applyActions(
      { actions: [{ type: 'tag', keywords: [] }] },
      { id: 9 },
      { folders: [] },
    );
    expect(r.applied).toEqual(['tag']);
    // Нет вызова update.
    expect(mock.calls.update.length).toBe(0);
  });
  it('redirect → skipped, не вызывает API', async () => {
    const r = await applyActions(
      { actions: [{ type: 'redirect', address: 'x@y' }] },
      { id: 12 },
      { folders: [] },
    );
    expect(r.skipped).toEqual(['redirect']);
    expect(r.applied).toEqual([]);
    expect(mock.calls.move.length + mock.calls.update.length + mock.calls.del.length).toBe(0);
  });
  it('несколько actions подряд', async () => {
    const folders = [{ id: 'dst', path: '/X' }];
    const r = await applyActions(
      { actions: [
        { type: 'fileinto', folder: '/X' },
        { type: 'mark_read' },
        { type: 'flag' },
      ]},
      { id: 100 },
      { folders },
    );
    expect(r.applied).toEqual(['fileinto', 'mark_read', 'flag']);
    expect(mock.calls.move.length).toBe(1);
    expect(mock.calls.update.length).toBe(2);
  });
  it('ошибка в одном action не валит остальные', async () => {
    mock.messages.update = vi.fn(async () => { throw new Error('boom'); });
    vi.stubGlobal('browser', { messages: mock.messages, folders: mock.folders });
    const folders = [{ id: 'dst', path: '/X' }];
    const r = await applyActions(
      { actions: [
        { type: 'mark_read' },
        { type: 'fileinto', folder: '/X' },
      ]},
      { id: 1 },
      { folders },
    );
    expect(r.errors.length).toBe(1);
    expect(r.applied).toContain('fileinto');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// runRuleOnFolder
// ────────────────────────────────────────────────────────────────────────────
describe('runRuleOnFolder', () => {
  it('пустая папка → processed=0, matched=0', async () => {
    const mock = makePagedBrowser([], 2);
    vi.stubGlobal('browser', mock);
    const rule = { conditions: [{ field: 'from', op: 'contains', value: 'x' }], actions: [] };
    const sum = await runRuleOnFolder(rule, 'fid');
    expect(sum.processed).toBe(0);
    expect(sum.matched).toBe(0);
    expect(sum.applied).toBe(0);
    expect(sum.errors).toEqual([]);
  });

  it('одна страница, два письма, одно подходит', async () => {
    const all = [
      { id: 1, author: 'alice@x', subject: 's1' },
      { id: 2, author: 'bob@x', subject: 's2' },
    ];
    const mock = makePagedBrowser(all, 5);
    vi.stubGlobal('browser', mock);
    const rule = {
      conditions: [{ field: 'from', op: 'contains', value: 'alice' }],
      actions: [{ type: 'mark_read' }],
    };
    const sum = await runRuleOnFolder(rule, 'fid');
    expect(sum.processed).toBe(2);
    expect(sum.matched).toBe(1);
    expect(sum.applied).toBe(1);
    expect(mock.calls.update).toEqual([{ id: 1, props: { read: true } }]);
  });

  it('пагинация — несколько страниц через continueList', async () => {
    const all = [
      { id: 1, author: 'a@x', subject: 's' },
      { id: 2, author: 'b@x', subject: 's' },
      { id: 3, author: 'a@x', subject: 's' },
      { id: 4, author: 'b@x', subject: 's' },
      { id: 5, author: 'a@x', subject: 's' },
    ];
    const mock = makePagedBrowser(all, 2);
    vi.stubGlobal('browser', mock);
    const rule = {
      conditions: [{ field: 'from', op: 'contains', value: 'a@x' }],
      actions: [{ type: 'mark_read' }],
    };
    const sum = await runRuleOnFolder(rule, 'fid');
    expect(sum.processed).toBe(5);
    expect(sum.matched).toBe(3);
    expect(mock.calls.continueList.length).toBeGreaterThan(0);
  });

  it('onProgress дёргается финально, и summary содержит правильные числа', async () => {
    const all = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1, author: i % 2 ? 'a@x' : 'b@x', subject: 's',
    }));
    const mock = makePagedBrowser(all, 3);
    vi.stubGlobal('browser', mock);
    const reports = [];
    const rule = {
      conditions: [{ field: 'from', op: 'contains', value: 'a@x' }],
      actions: [{ type: 'mark_read' }],
    };
    const sum = await runRuleOnFolder(rule, 'fid', {
      onProgress: (s) => reports.push({ ...s }),
    });
    // Финальный отчёт обязательно есть.
    expect(reports.length).toBeGreaterThan(0);
    const last = reports[reports.length - 1];
    expect(last.processed).toBe(10);
    expect(last.matched).toBe(5);
    expect(sum.matched).toBe(5);
    expect(sum.total).toBe(10);
  });

  it('abort через AbortSignal — преждевременный выход с aborted:true', async () => {
    const all = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1, author: 'a@x', subject: 's',
    }));
    const mock = makePagedBrowser(all, 50);
    vi.stubGlobal('browser', mock);
    const ctrl = new AbortController();
    let count = 0;
    const onProgress = () => {
      count++;
      if (count === 1) ctrl.abort();
    };
    const rule = {
      conditions: [{ field: 'from', op: 'contains', value: 'a@x' }],
      actions: [{ type: 'mark_read' }],
    };
    const sum = await runRuleOnFolder(rule, 'fid', {
      signal: ctrl.signal,
      onProgress,
    });
    expect(sum.aborted).toBe(true);
    expect(sum.errors).toContain('aborted');
    expect(sum.processed).toBeLessThan(200);
  });

  it('redirect action → summary.skipped содержит "redirect"', async () => {
    const all = [{ id: 1, author: 'a@x', subject: 's' }];
    const mock = makePagedBrowser(all, 5);
    vi.stubGlobal('browser', mock);
    const rule = {
      conditions: [{ field: 'from', op: 'contains', value: 'a@x' }],
      actions: [{ type: 'redirect', address: 'x@y' }],
    };
    const sum = await runRuleOnFolder(rule, 'fid');
    expect(sum.matched).toBe(1);
    expect(sum.skipped).toContain('redirect');
    expect(mock.calls.move.length).toBe(0);
  });

  it('header condition → getFull вызывается', async () => {
    const all = [{ id: 7, author: 'a@x', subject: 's' }];
    const mock = makePagedBrowser(all, 5);
    // Override getFull для возврата конкретных headers.
    mock.messages.getFull = vi.fn(async (id) => {
      mock.calls.getFull.push(id);
      return { headers: { 'list-id': ['<weekly>'] }, parts: [] };
    });
    vi.stubGlobal('browser', mock);
    const rule = {
      conditions: [{ field: 'header', headerName: 'List-Id', op: 'contains', value: 'weekly' }],
      actions: [{ type: 'mark_read' }],
    };
    const sum = await runRuleOnFolder(rule, 'fid');
    expect(mock.calls.getFull).toEqual([7]);
    expect(sum.matched).toBe(1);
    expect(sum.applied).toBe(1);
  });

  it('правило только по from → getFull НЕ вызывается (оптимизация)', async () => {
    const all = [{ id: 1, author: 'a@x' }, { id: 2, author: 'b@x' }];
    const mock = makePagedBrowser(all, 5);
    vi.stubGlobal('browser', mock);
    const rule = {
      conditions: [{ field: 'from', op: 'contains', value: 'a@x' }],
      actions: [{ type: 'mark_read' }],
    };
    await runRuleOnFolder(rule, 'fid');
    expect(mock.calls.getFull.length).toBe(0);
  });

  it('total из getFolderInfo — попадает в summary', async () => {
    const all = [{ id: 1, author: 'a@x' }];
    const mock = makePagedBrowser(all, 5);
    vi.stubGlobal('browser', mock);
    const rule = {
      conditions: [{ field: 'from', op: 'contains', value: 'a@x' }],
      actions: [],
    };
    const sum = await runRuleOnFolder(rule, 'fid');
    expect(sum.total).toBe(1);
  });

  it('messages.list бросает → ошибка в summary, не throw', async () => {
    const mock = makePagedBrowser([], 5);
    mock.messages.list = vi.fn(async () => { throw new Error('list-failed'); });
    vi.stubGlobal('browser', mock);
    const rule = {
      conditions: [{ field: 'from', op: 'contains', value: 'a' }],
      actions: [],
    };
    const sum = await runRuleOnFolder(rule, 'fid');
    expect(sum.processed).toBe(0);
    expect(sum.errors.some(e => e.includes('list'))).toBe(true);
  });

  it('signal уже aborted при старте → сразу выход', async () => {
    const mock = makePagedBrowser([{ id: 1, author: 'a@x' }], 5);
    vi.stubGlobal('browser', mock);
    const ctrl = new AbortController();
    ctrl.abort();
    const sum = await runRuleOnFolder(
      { conditions: [{ field: 'from', op: 'contains', value: 'a' }], actions: [] },
      'fid',
      { signal: ctrl.signal },
    );
    expect(sum.aborted).toBe(true);
    expect(sum.processed).toBe(0);
  });

  it('resolve fileinto через preloaded folders', async () => {
    const all = [{ id: 1, author: 'a@x' }];
    const mock = makePagedBrowser(all, 5);
    vi.stubGlobal('browser', mock);
    const folders = [{ id: 'dst-id', path: '/INBOX/X' }];
    const rule = {
      conditions: [{ field: 'from', op: 'contains', value: 'a@x' }],
      actions: [{ type: 'fileinto', folder: '/INBOX/X' }],
    };
    const sum = await runRuleOnFolder(rule, 'src-fid', { folders });
    expect(sum.matched).toBe(1);
    expect(sum.applied).toBe(1);
    expect(mock.calls.move).toEqual([{ ids: [1], destId: 'dst-id' }]);
  });

  it('progress reports каждые 50 messages (≥1 промежуточный отчёт на 75 писем)', async () => {
    const all = Array.from({ length: 75 }, (_, i) => ({ id: i + 1, author: 'a@x' }));
    const mock = makePagedBrowser(all, 100); // одна страница
    vi.stubGlobal('browser', mock);
    const reports = [];
    const rule = {
      conditions: [{ field: 'from', op: 'contains', value: 'a@x' }],
      actions: [],
    };
    await runRuleOnFolder(rule, 'fid', {
      onProgress: (s) => reports.push({ ...s }),
    });
    // 75 messages → 1 промежуточный (после 50) + 1 финальный = ≥2.
    expect(reports.length).toBeGreaterThanOrEqual(2);
  });
});
