import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupportedStorage } from '@supabase/auth-js';

const serverStorage: SupportedStorage = {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
};

const webStorage: SupportedStorage = {
    getItem: (key) => (typeof window === 'undefined' ? serverStorage.getItem(key) : AsyncStorage.getItem(key)),
    setItem: (key, value) =>
        typeof window === 'undefined' ? serverStorage.setItem(key, value) : AsyncStorage.setItem(key, value),
    removeItem: (key) =>
        typeof window === 'undefined' ? serverStorage.removeItem(key) : AsyncStorage.removeItem(key),
};

export default webStorage;
