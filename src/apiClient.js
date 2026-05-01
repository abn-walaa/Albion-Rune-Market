import axios from 'axios';

export const api = axios.create({
    timeout: 30000,
    headers: {
        'Accept-Encoding': 'gzip',
    },
});
