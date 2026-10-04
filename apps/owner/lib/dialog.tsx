import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import AppDialog, { DialogOptions } from '../components/AppDialog';

interface DialogContextValue {
  show: (options: DialogOptions) => void;
  hide: () => void;
}

const DialogContext = createContext<DialogContextValue | undefined>(undefined);

// Provee un modal con diseño de marca a toda la app (reemplaza los Alert del sistema).
export function DialogProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [opts, setOpts] = useState<DialogOptions>({ title: '' });

  const show = useCallback((options: DialogOptions) => {
    setOpts(options);
    setVisible(true);
  }, []);
  const hide = useCallback(() => setVisible(false), []);

  return (
    <DialogContext.Provider value={{ show, hide }}>
      {children}
      <AppDialog
        visible={visible}
        type={opts.type}
        title={opts.title}
        message={opts.message}
        confirmText={opts.confirmText}
        onClose={() => { hide(); opts.alCerrar?.(); }}
      />
    </DialogContext.Provider>
  );
}

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog debe usarse dentro de DialogProvider');
  return ctx;
}
