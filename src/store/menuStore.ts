import { create } from 'zustand';

// Open/closed state of the side navigation menu (see components/MenuShell.tsx). Kept in a
// store - rather than inside a page - because the menu itself lives once, in the layout that wraps
// all routes.
interface MenuState {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

export const useMenuStore = create<MenuState>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
}));
