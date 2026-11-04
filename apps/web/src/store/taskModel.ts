import { create } from 'zustand';
import type { TaskModelSelection } from '@wangke/contracts/cloud';
import { cloud } from '../cloud/state';

export const taskModelKey = (session: number | string | null) => `${cloud.userId ?? 'local'}:${session ?? 'draft'}`;
export const useTaskModel = create<{ choices: Record<string, TaskModelSelection>; set(key: string, value?: TaskModelSelection): void }>(set => ({
  choices: {}, set: (key, value) => set(state => {
    const choices = { ...state.choices };
    if (value) choices[key] = value; else delete choices[key];
    return { choices };
  }),
}));
export const taskModelChoice = (session: number | string | null) => useTaskModel.getState().choices[taskModelKey(session)];
