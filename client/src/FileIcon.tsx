import { File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Folder } from 'lucide-react';

export function FileTypeIcon({ mime, name, folder = false, className = 'type-icon' }: { mime?: string | null; name: string; folder?: boolean; className?: string }) {
  if (folder) return <Folder className={className} aria-hidden="true" />;
  const lower = name.toLowerCase();
  const type = mime ?? '';
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lower)) return <FileImage className={className} aria-hidden="true" />;
  if (type.startsWith('video/') || /\.(mp4|mov|mkv|webm|avi)$/.test(lower)) return <FileVideo className={className} aria-hidden="true" />;
  if (type.startsWith('audio/') || /\.(mp3|wav|flac|aac|ogg)$/.test(lower)) return <FileAudio className={className} aria-hidden="true" />;
  if (/\.(zip|rar|7z|tar|gz)$/.test(lower)) return <FileArchive className={className} aria-hidden="true" />;
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|css|html|json|xml|yml|yaml)$/.test(lower) || type.includes('javascript') || type.includes('json')) {
    return <FileCode className={className} aria-hidden="true" />;
  }
  if (/\.(xls|xlsx|csv|numbers)$/.test(lower) || type.includes('spreadsheet') || type.includes('csv')) return <FileSpreadsheet className={className} aria-hidden="true" />;
  if (type.startsWith('text/') || /\.(txt|md|pdf|rtf|doc|docx)$/.test(lower)) return <FileText className={className} aria-hidden="true" />;
  return <File className={className} aria-hidden="true" />;
}

export function isProbablyText(mime: string | null, name: string, size: number) {
  if (size > 2 * 1024 * 1024) return false;
  if (mime?.startsWith('text/')) return true;
  return /\.(txt|md|json|csv|log|css|js|ts|tsx|jsx|html|xml|yml|yaml|svg)$/i.test(name);
}
