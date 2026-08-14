dev:
    ./node_modules/.bin/vite --port=7000

build:
    ./node_modules/.bin/vite build

deploy-dev: build
    rsync -avz --delete dist/ root@62.238.111.199:/var/www/nostrapps-dev/

promote:
    ssh root@62.238.111.199 'rsync -a --delete /var/www/nostrapps-dev/ /var/www/nostrapps/'
