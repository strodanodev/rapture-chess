/**
 * Famous checkmates for the main menu's board, as the games' own moves (replayed with chess.js, so every final
 * position is a real, verified mate: test/mates.test.mjs). Studies without a game are given as a position.
 */
export interface Mate {
  name: string;
  /** Who played it, and where and when. */
  where: string;
  /** The moves from the start (SAN), or a FEN for a composed pattern. */
  moves?: string;
  fen?: string;
}

export const MATES: Mate[] = [
  { name: 'The Opera Game', where: 'Morphy vs Duke Karl & Count Isouard, Paris 1858',
    moves: 'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#' },
  { name: 'The Immortal Game', where: 'Anderssen vs Kieseritzky, London 1851',
    moves: 'e4 e5 f4 exf4 Bc4 Qh4+ Kf1 b5 Bxb5 Nf6 Nf3 Qh6 d3 Nh5 Nh4 Qg5 Nf5 c6 g4 Nf6 Rg1 cxb5 h4 Qg6 h5 Qg5 Qf3 Ng8 Bxf4 Qf6 Nc3 Bc5 Nd5 Qxb2 Bd6 Bxg1 e5 Qxa1+ Ke2 Na6 Nxg7+ Kd8 Qf6+ Nxf6 Be7#' },
  { name: 'The Evergreen Game', where: 'Anderssen vs Dufresne, Berlin 1852',
    moves: 'e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4 c3 Ba5 d4 exd4 O-O d3 Qb3 Qf6 e5 Qg6 Re1 Nge7 Ba3 b5 Qxb5 Rb8 Qa4 Bb6 Nbd2 Bb7 Ne4 Qf5 Bxd3 Qh5 Nf6+ gxf6 exf6 Rg8 Rad1 Qxf3 Rxe7+ Nxe7 Qxd7+ Kxd7 Bf5+ Ke8 Bd7+ Kf8 Bxe7#' },
  { name: 'The King Hunt', where: 'Edward Lasker vs Thomas, London 1912',
    moves: 'd4 e6 Nf3 f5 Nc3 Nf6 Bg5 Be7 Bxf6 Bxf6 e4 fxe4 Nxe4 b6 Ne5 O-O Bd3 Bb7 Qh5 Qe7 Qxh7+ Kxh7 Nxf6+ Kh6 Neg4+ Kg5 h4+ Kf4 g3+ Kf3 Be2+ Kg2 Rh2+ Kg1 Kd2#' },
  { name: 'Réti\'s Bishops', where: 'Réti vs Tartakower, Vienna 1910',
    moves: 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Nf6 Qd3 e5 dxe5 Qa5+ Bd2 Qxe5 O-O-O Nxe4 Qd8+ Kxd8 Bg5+ Kc7 Bd8#' },
  { name: 'Legal\'s Mate', where: 'Légal de Kermur vs Saint Brie, Paris 1750',
    moves: 'e4 e5 Nf3 d6 Bc4 Bg4 Nc3 g6 Nxe5 Bxd1 Bxf7+ Ke7 Nd5#' },
  { name: 'Smothered Mate', where: 'The Blackburne Shilling Gambit',
    moves: 'e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5 Qg5 Nxf7 Qxg2 Rf1 Qxe4+ Be2 Nf3#' },
  { name: 'Scholar\'s Mate', where: 'The oldest trap in the book',
    moves: 'e4 e5 Bc4 Nc6 Qh5 Nf6 Qxf7#' },
  { name: 'Fool\'s Mate', where: 'The fastest mate there is',
    moves: 'f3 e5 g4 Qh4#' },
  { name: 'The Arabian Mate', where: 'A pattern a thousand years old',
    fen: '7k/7R/5N2/8/8/8/8/K7 b - - 0 1' },
];
