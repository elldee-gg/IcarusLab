import { useEffect, useMemo, useState, type DragEvent, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { FolderPlus, LayoutGrid, List, Trash2, Upload } from 'lucide-react';
import { api, ApiError } from './api';
import { useAuth } from './auth';
import { FileTypeIcon, isProbablyText } from './FileIcon';
import { formatBytes, formatWhen } from './format';
import { Heading } from './shell';

type NodeItem = {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'file' | 'folder';
  mime: string | null;
  sizeBytes: number;
  version: number;
  visibility: 'private' | 'shared' | 'public';
  updatedAt: number;
  permission: 'owner' | 'edit' | 'view';
  image: boolean;
  parentName?: string;
  publicPath?: string | null;
  shares?: { username: string; permission: 'view' | 'edit' }[];
};

type Crumb = { id: string | null; name: string };
type SortKey = 'name' | 'updated' | 'size' | 'kind';

async function sha256Hex(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function DrivePage() {
  const { refresh } = useAuth();
  const { folderId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const pathName = window.location.pathname;
  const view = pathName.endsWith('/shared') ? 'shared' : pathName.endsWith('/trash') ? 'trash' : pathName.endsWith('/search') ? 'search' : 'files';
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [path, setPath] = useState<Crumb[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [layout, setLayout] = useState(localStorage.getItem('icarus-layout') === 'grid' ? 'grid' : 'list');
  const [sort, setSort] = useState<SortKey>((localStorage.getItem('icarus-sort') as SortKey) || 'name');
  const [trashQuery, setTrashQuery] = useState('');
  const [uploads, setUploads] = useState<{ name: string; progress: number; error?: string }[]>([]);
  const [dialog, setDialog] = useState<null | { type: 'folder' | 'rename' | 'share' | 'move' | 'text' | 'confirm'; node?: NodeItem }>(null);
  const [folderPerm, setFolderPerm] = useState<NodeItem['permission']>('owner');
  const search = searchParams.get('q') ?? '';

  async function load() {
    setLoading(true);
    setError('');
    try {
      if (view === 'shared') {
        const data = await api<{ nodes: NodeItem[] }>('/api/nodes/shared');
        setNodes(data.nodes);
        setPath([]);
      } else if (view === 'trash') {
        const data = await api<{ nodes: NodeItem[] }>(`/api/nodes/trash?q=${encodeURIComponent(trashQuery)}`);
        setNodes(data.nodes);
        setPath([]);
      } else if (view === 'search') {
        const data = await api<{ nodes: NodeItem[] }>(`/api/nodes/search?q=${encodeURIComponent(search)}`);
        setNodes(data.nodes);
        setPath([]);
      } else {
        const data = await api<{ nodes: NodeItem[]; path: Crumb[] }>(folderId ? `/api/nodes?parentId=${folderId}` : '/api/nodes');
        setNodes(data.nodes);
        setPath(data.path);
        if (folderId) {
          const folder = await api<NodeItem>(`/api/nodes/${folderId}`);
          setFolderPerm(folder.permission);
        } else setFolderPerm('owner');
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load files');
    } finally {
      setLoading(false);
      setSelected([]);
    }
  }

  useEffect(() => { void load(); }, [view, folderId, search, trashQuery]);

  const shown = useMemo(() => {
    const copy = [...nodes];
    copy.sort((a, b) => {
      if (sort === 'kind' && a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      if (sort === 'size') return a.sizeBytes - b.sizeBytes;
      if (sort === 'updated') return b.updatedAt - a.updatedAt;
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return copy;
  }, [nodes, sort]);

  const parentId = view === 'files' ? folderId ?? null : null;
  const canWrite = view === 'files' && folderPerm !== 'view';

  function toggle(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = [...files];
    for (const file of list) {
      setUploads((current) => [...current, { name: file.name, progress: 0 }]);
      try {
        await sendFile(file, parentId, (progress) => {
          setUploads((current) => current.map((item) => (item.name === file.name ? { ...item, progress } : item)));
        });
        setUploads((current) => current.map((item) => (item.name === file.name ? { ...item, progress: 1 } : item)));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        setUploads((current) => current.map((item) => (item.name === file.name ? { ...item, error: message } : item)));
      }
    }
    await load();
  }

  async function onDrop(event: DragEvent) {
    event.preventDefault();
    if (view !== 'files') return;
    await uploadFiles(event.dataTransfer.files);
  }

  return (
    <>
        <main className="content" onDragOver={(event) => event.preventDefault()} onDrop={(event) => void onDrop(event)}>
          <div className="toolbar">
            <div className="crumbs">
              {view === 'files' && path.map((crumb, index) => (
                <span key={`${crumb.id ?? 'root'}-${index}`}>
                  {index > 0 && <span className="sep">/</span>}
                  <button type="button" className="text" onClick={() => navigate(crumb.id ? `/dashboard/folder/${crumb.id}` : '/dashboard')}>{crumb.name}</button>
                </span>
              ))}
              {view === 'shared' && <Heading>Shared with me</Heading>}
              {view === 'trash' && <Heading>Trash</Heading>}
              {view === 'search' && <Heading>Search</Heading>}
            </div>
            <div className="actions">
              {view === 'trash' && <input value={trashQuery} onChange={(event) => setTrashQuery(event.target.value)} placeholder="Filter trash" aria-label="Filter trash" />}
              {view === 'files' && canWrite && (
                <>
                  <button type="button" onClick={() => setDialog({ type: 'folder' })}><FolderPlus size={16} /> New folder</button>
                  <label className="file-button">
                    <Upload size={16} /> Upload
                    <input type="file" multiple hidden onChange={(event) => { if (event.target.files) void uploadFiles(event.target.files); event.target.value = ''; }} />
                  </label>
                </>
              )}
              {selected.length > 0 && view === 'files' && <button type="button" onClick={() => setDialog({ type: 'move' })}>Move</button>}
              {selected.length > 0 && view !== 'trash' && <button type="button" onClick={() => setDialog({ type: 'confirm', node: undefined })}><Trash2 size={16} /> Trash</button>}
              {selected.length > 0 && view === 'trash' && <button type="button" onClick={() => void restoreSelected(selected, load, setError)}>Restore</button>}
              {selected.length > 0 && view === 'trash' && <button type="button" className="danger" onClick={() => void destroySelected(selected, load, setError)}>Delete forever</button>}
              {view === 'trash' && nodes.length > 0 && <button type="button" className="danger" onClick={() => void emptyTrash(load, setError)}>Empty trash</button>}
              <label className="sort">
                Sort
                <select value={sort} onChange={(event) => { const value = event.target.value as SortKey; setSort(value); localStorage.setItem('icarus-sort', value); }}>
                  <option value="name">Name</option>
                  <option value="updated">Date</option>
                  <option value="size">Size</option>
                  <option value="kind">Kind</option>
                </select>
              </label>
              <button type="button" className="icon" aria-label={layout === 'list' ? 'Thumbnail grid' : 'List'} onClick={() => { const next = layout === 'list' ? 'grid' : 'list'; setLayout(next); localStorage.setItem('icarus-layout', next); }}>
                {layout === 'list' ? <LayoutGrid size={16} /> : <List size={16} />}
              </button>
            </div>
          </div>
          {error && <p className="error">{error}</p>}
          {loading ? <p className="hint">Loading files…</p> : shown.length === 0 ? <p className="empty glass">Nothing is here yet.</p> : layout === 'grid' ? (
            <div className="grid">
              {shown.map((node) => (
                <article key={node.id} className="tile glass">
                  <input type="checkbox" checked={selected.includes(node.id)} onChange={() => toggle(node.id)} aria-label={`Select ${node.name}`} />
                  <button type="button" className="tile-main" onClick={() => openNode(node, view, navigate)}>
                    <Thumb node={node} />
                    <strong>{node.name}</strong>
                  </button>
                  <small>{node.kind === 'folder' ? 'Folder' : formatBytes(node.sizeBytes)}</small>
                  <RowMenu node={node} view={view} onChange={load} onDialog={setDialog} />
                </article>
              ))}
            </div>
          ) : (
            <div className="table glass">
              <div className="row head" aria-hidden="true">
                <span />
                <span>Name</span>
                <span>Access</span>
                <span>Size</span>
                <span>Modified</span>
                <span />
              </div>
              {shown.map((node) => (
                <div className="row" key={node.id}>
                  <input type="checkbox" checked={selected.includes(node.id)} onChange={() => toggle(node.id)} aria-label={`Select ${node.name}`} />
                  <button type="button" className="name" onClick={() => openNode(node, view, navigate)}>
                    <Thumb node={node} small />
                    <span>{node.name}</span>
                  </button>
                  <span>{node.visibility}</span>
                  <span>{node.kind === 'folder' ? '—' : formatBytes(node.sizeBytes)}</span>
                  <span>{formatWhen(node.updatedAt)}</span>
                  <RowMenu node={node} view={view} onChange={load} onDialog={setDialog} />
                </div>
              ))}
            </div>
          )}
          {uploads.length > 0 && (
            <aside className="uploads glass">
              {uploads.map((item) => (
                <p key={item.name}>{item.name} {item.error ? item.error : `${Math.round(item.progress * 100)}%`}</p>
              ))}
            </aside>
          )}
        </main>
      {dialog && (
        <Dialog
          dialog={dialog}
          parentId={parentId}
          selected={selected}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); void load(); }}
        />
      )}
    </>
  );
}

function Thumb({ node, small = false }: { node: NodeItem; small?: boolean }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  if (!node.image || failed) return <FileTypeIcon folder={node.kind === 'folder'} mime={node.mime} name={node.name} className={small ? 'type-icon' : 'type-icon big'} />;
  return (
    <img
      className={small ? 'thumb small' : 'thumb'}
      alt=""
      src={`/api/nodes/${node.id}/thumb?try=${attempt}`}
      onError={() => {
        if (attempt < 4) window.setTimeout(() => setAttempt((value) => value + 1), 700);
        else setFailed(true);
      }}
    />
  );
}

function openNode(node: NodeItem, view: string, navigate: ReturnType<typeof useNavigate>) {
  if (view === 'trash') return;
  if (node.kind === 'folder') navigate(`/dashboard/folder/${node.id}`);
  else window.location.assign(`/api/nodes/${node.id}/download`);
}

function RowMenu({ node, view, onChange, onDialog }: { node: NodeItem; view: string; onChange: () => Promise<void>; onDialog: (dialog: { type: 'rename' | 'share' | 'text'; node: NodeItem }) => void }) {
  if (view === 'trash' || view === 'search' && node.permission === 'view') {
    return node.permission !== 'view' && view !== 'trash' ? <ItemActions node={node} onDialog={onDialog} /> : <span />;
  }
  return <ItemActions node={node} onDialog={onDialog} />;
}

function ItemActions({ node, onDialog }: { node: NodeItem; onDialog: (dialog: { type: 'rename' | 'share' | 'text'; node: NodeItem }) => void }) {
  const canEdit = node.permission === 'owner' || node.permission === 'edit';
  return (
    <span className="row-actions">
      {node.kind === 'file' && node.image && <a href={`/api/nodes/${node.id}/download?inline=1`} target="_blank" rel="noreferrer">View</a>}
      {node.kind === 'file' && <a href={`/api/nodes/${node.id}/download`}>Download</a>}
      {canEdit && <button type="button" onClick={() => onDialog({ type: 'rename', node })}>Rename</button>}
      {canEdit && node.kind === 'file' && isProbablyText(node.mime, node.name, node.sizeBytes) && <button type="button" onClick={() => onDialog({ type: 'text', node })}>Edit</button>}
      {node.permission === 'owner' && <button type="button" onClick={() => onDialog({ type: 'share', node })}>Share</button>}
    </span>
  );
}

async function sendFile(file: File, parentId: string | null, onProgress: (value: number) => void) {
  const key = `upload:${parentId ?? ''}:${file.name}:${file.size}:${file.lastModified}`;
  let uploadId = sessionStorage.getItem(key);
  let chunkSize = 8 * 1024 * 1024;
  let received: number[] = [];
  if (uploadId) {
    try {
      const info = await api<{ received: number[]; chunkSize: number }>(`/api/uploads/${uploadId}`);
      received = info.received;
      chunkSize = info.chunkSize;
    } catch {
      uploadId = null;
    }
  }
  if (!uploadId) {
    const created = await api<{ id: string; chunkSize: number }>('/api/uploads', {
      method: 'POST',
      body: JSON.stringify({ parentId, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' }),
    });
    uploadId = created.id;
    chunkSize = created.chunkSize;
    sessionStorage.setItem(key, uploadId);
  }
  const count = file.size === 0 ? 0 : Math.ceil(file.size / chunkSize);
  for (let index = 0; index < count; index += 1) {
    if (received.includes(index)) {
      onProgress((index + 1) / count);
      continue;
    }
    const blob = file.slice(index * chunkSize, Math.min(file.size, (index + 1) * chunkSize));
    const buffer = await blob.arrayBuffer();
    const checksum = await sha256Hex(buffer);
    await api(`/api/uploads/${uploadId}/chunks/${index}`, { method: 'PUT', body: buffer, headers: { 'X-Chunk-Sha256': checksum } });
    onProgress((index + 1) / count);
  }
  await api(`/api/uploads/${uploadId}/complete`, { method: 'POST' });
  sessionStorage.removeItem(key);
}

async function restoreSelected(ids: string[], load: () => Promise<void>, setError: (value: string) => void) {
  try {
    for (const id of ids) await api(`/api/nodes/${id}/restore`, { method: 'POST' });
    await load();
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Could not restore');
  }
}

async function destroySelected(ids: string[], load: () => Promise<void>, setError: (value: string) => void) {
  if (!window.confirm('Delete the selected items forever?')) return;
  try {
    await api('/api/nodes/bulk/delete', { method: 'POST', body: JSON.stringify({ ids }) });
    await load();
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Could not delete');
  }
}

async function emptyTrash(load: () => Promise<void>, setError: (value: string) => void) {
  if (!window.confirm('Empty the trash forever?')) return;
  try {
    await api('/api/nodes/trash/empty', { method: 'POST' });
    await load();
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Could not empty the trash');
  }
}

function Dialog({ dialog, parentId, selected, onClose, onDone }: { dialog: { type: string; node?: NodeItem }; parentId: string | null; selected: string[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(dialog.node?.name ?? '');
  const [text, setText] = useState('');
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const [visibility, setVisibility] = useState(dialog.node?.visibility ?? 'private');
  const [shares, setShares] = useState<{ username: string; permission: 'view' | 'edit' }[]>(dialog.node?.shares ?? []);
  const [publicPath, setPublicPath] = useState(dialog.node?.publicPath ?? '');
  const [folders, setFolders] = useState<NodeItem[]>([]);
  const [moveParent, setMoveParent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (dialog.type === 'text' && dialog.node) {
      void api<{ content: string; version: number }>(`/api/nodes/${dialog.node.id}/text`).then((data) => {
        setText(data.content);
        setVersion(data.version);
      }).catch((err) => setError(err instanceof Error ? err.message : 'Could not open the file'));
    }
    if (dialog.type === 'share' && dialog.node) {
      void api<NodeItem>(`/api/nodes/${dialog.node.id}`).then((data) => {
        setVisibility(data.visibility);
        setShares(data.shares ?? []);
        setPublicPath(data.publicPath ?? '');
      }).catch((err) => setError(err instanceof Error ? err.message : 'Could not load sharing'));
    }
    if (dialog.type === 'move') void loadFolders(null);
  }, [dialog]);

  async function loadFolders(id: string | null) {
    const data = await api<{ nodes: NodeItem[] }>(id ? `/api/nodes?parentId=${id}` : '/api/nodes');
    setFolders(data.nodes.filter((node) => node.kind === 'folder'));
    setMoveParent(id);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (dialog.type === 'folder') await api('/api/nodes/folders', { method: 'POST', body: JSON.stringify({ parentId, name }) });
      if (dialog.type === 'rename' && dialog.node) await api(`/api/nodes/${dialog.node.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      if (dialog.type === 'text' && dialog.node) {
        await api(`/api/nodes/${dialog.node.id}/text`, { method: 'PUT', body: JSON.stringify({ content: text, version }) });
      }
      if (dialog.type === 'share' && dialog.node) {
        const saved = await api<NodeItem>(`/api/nodes/${dialog.node.id}/access`, { method: 'PUT', body: JSON.stringify({ visibility, shares }) });
        setPublicPath(saved.publicPath ?? '');
        if (visibility === 'public') return;
      }
      if (dialog.type === 'move') await api('/api/nodes/bulk/move', { method: 'POST', body: JSON.stringify({ ids: selected, parentId: moveParent }) });
      if (dialog.type === 'confirm') await api('/api/nodes/bulk/trash', { method: 'POST', body: JSON.stringify({ ids: selected }) });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && typeof err.body?.content === 'string') {
        setError(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-back" role="presentation" onMouseDown={onClose}>
      <form className="glass modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={onSubmit}>
        <Heading>{dialog.type === 'folder' ? 'New folder' : dialog.type === 'rename' ? 'Rename' : dialog.type === 'text' ? dialog.node?.name : dialog.type === 'share' ? 'Sharing' : dialog.type === 'move' ? 'Move' : 'Move to trash'}</Heading>
        {(dialog.type === 'folder' || dialog.type === 'rename') && <input value={name} onChange={(event) => setName(event.target.value)} required autoFocus />}
        {dialog.type === 'text' && <textarea value={text} onChange={(event) => setText(event.target.value)} rows={16} />}
        {dialog.type === 'confirm' && <p>Move the selected items to the trash? They stay in your quota until you delete them forever.</p>}
        {dialog.type === 'share' && (
          <div className="stack">
            <label className="check"><input type="radio" checked={visibility === 'private'} onChange={() => setVisibility('private')} /> Private</label>
            <label className="check"><input type="radio" checked={visibility === 'shared'} onChange={() => setVisibility('shared')} /> Shared with people</label>
            <label className="check"><input type="radio" checked={visibility === 'public'} onChange={() => setVisibility('public')} /> Public link</label>
            {visibility === 'shared' && shares.map((share, index) => (
              <div className="share-row" key={index}>
                <input value={share.username} placeholder="username" onChange={(event) => setShares(shares.map((item, itemIndex) => itemIndex === index ? { ...item, username: event.target.value } : item))} />
                <select value={share.permission} onChange={(event) => setShares(shares.map((item, itemIndex) => itemIndex === index ? { ...item, permission: event.target.value as 'view' | 'edit' } : item))}>
                  <option value="view">View</option>
                  <option value="edit">Edit</option>
                </select>
              </div>
            ))}
            {visibility === 'shared' && <button type="button" onClick={() => setShares([...shares, { username: '', permission: 'view' }])}>Add person</button>}
            {visibility === 'public' && publicPath && <p className="hint">{window.location.origin}{publicPath}</p>}
          </div>
        )}
        {dialog.type === 'move' && (
          <div className="stack">
            <button type="button" onClick={() => void loadFolders(null)}>My files</button>
            {folders.map((folder) => <button type="button" key={folder.id} onClick={() => void loadFolders(folder.id)}>{folder.name}</button>)}
            <p className="hint">The items will be placed in the folder you are looking at.</p>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy} type="submit">{busy ? 'Saving…' : dialog.type === 'confirm' ? 'Move to trash' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}
