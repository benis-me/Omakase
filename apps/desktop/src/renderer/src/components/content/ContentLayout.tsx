import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '../ui/button';

export function ContentLayout({
  title,
  onNew,
  newLabel = 'New',
  actions,
  children,
}: {
  title: string;
  onNew?: () => void;
  newLabel?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <h2 className="text-[13px] font-medium">{title}</h2>
        <div className="ml-auto flex items-center gap-1.5">
          {actions}
          {onNew && (
            <Button variant="omk" size="sm" className="gap-1.5" onClick={onNew}>
              <Plus className="size-3.5" />
              {newLabel}
            </Button>
          )}
        </div>
      </header>
      <div className="flex min-h-0 flex-1">{children}</div>
    </div>
  );
}

export function EmptyDetail({ message }: { message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <p className="max-w-xs text-center text-[12px] leading-relaxed text-muted-foreground">
        {message}
      </p>
    </div>
  );
}
