
const properties = [
    'upport',
    'game',
    'gamecode',
    'fullgamename',
    'gamefile',
    'gamehost',
    'gameport',
    'key'
]

export class SAL {

    upport: number
    game: string
    gamecode: string
    fullgamename: string
    gamefile: string
    gamehost: string
    gameport: number
    key: string

    constructor () {
        this.upport = 0
        this.game = ''
        this.gamecode = ''
        this.fullgamename = ''
        this.gamefile = ''
        this.gamehost = ''
        this.gameport = 0
        this.key = ''
    }

    [index: string]: any

    static parseEAccessResponse (reply: Array<string>) {
        let sal = new this ()
        for (let n = 2, nn = reply.length; n < nn; n++) {
            let [key, value] = reply[n].split('=')
            key = key.toLowerCase()
            if (key === 'upport' || key === 'gameport') {
                sal[key] = Number(value)
            } else {
                sal[key] = value
            }
        }
        return sal
    }
}
