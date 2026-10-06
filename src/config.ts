/**
 * Parâmetros ajustáveis. Unidade de mundo = 1 metro; o chão é o plano XZ.
 * Velocidade e passada definem juntas a cadência: ciclos/s = velocidade / passada.
 * Os valores de passada vêm do pipeline (medidos nas vistas laterais) e podem ser
 * sobrescritos aqui ou no painel de ajustes.
 */
export const config = {
  /** Altura da personagem em pé, em metros — define a escala px do atlas → mundo. */
  characterHeight: 1.6,

  camera: {
    /** Elevação de 30° = projeção dimétrica 2:1 (o "isométrico" clássico de pixel art). */
    pitchDeg: 30,
    yawDeg: 45,
    /** Px de tela (CSS) por px do atlas. */
    zoom: 0.75,
    zoomMin: 0.35,
    zoomMax: 1.6,
    /** Rigidez do acompanhamento (maior = câmera mais presa). */
    follow: 7,
  },

  walk: {
    /** Duração de um ciclo completo (2 passos), em segundos. */
    cycleSeconds: 1.05,
    /** Metros por ciclo; null = usa a medida do pipeline. */
    strideOverride: null as number | null,
  },

  run: {
    cycleSeconds: 0.62,
    strideOverride: null as number | null,
  },

  locomotion: {
    /** Taxa de aceleração/frenagem exponencial (1/s). */
    accel: 9,
    decel: 14,
    /** Velocidade angular do giro, em graus/s. */
    turnRateDeg: 720,
    /**
     * Ao parar, a animação termina o passo até a próxima pose de passagem
     * nesta cadência mínima (ciclos/s) — evita "estalar" de pernas abertas para o idle.
     */
    settleRate: 2.4,
    /** Abaixo disto (m/s) sem input, a personagem está parada. */
    stopSpeed: 0.04,
  },

  idle: {
    /** Respiração: variação vertical da pose parada (0 desliga). 0,006 ≈ 1 px na altura da personagem. */
    breathAmplitude: 0.006,
    /** Segundos por respiração. */
    breathPeriod: 3.4,
  },

  slide: {
    /** Segundos com o corpo no chão (contato → começo da subida). */
    groundSeconds: 0.6,
    /** Segundos da subida até voltar a correr. */
    recoverSeconds: 0.42,
    /** Velocidade no contato ÷ velocidade da corrida (impulso do mergulho). */
    boost: 1.3,
    /** Velocidade ao começar a levantar ÷ velocidade da corrida (efeito do atrito). */
    endRatio: 0.3,
    /** Taxa de retomada da corrida ao levantar (1/s). */
    accel: 9,
    /** Espera mínima entre deslizes (s). */
    cooldown: 0.2,
    /** Metros entre nuvens de poeira no chão. */
    dustSpacing: 0.36,
  },

  dust: {
    /** Largura da nuvem (m) no frame mais cheio. */
    size: 0.72,
    /** Duração de cada nuvem (s). */
    life: 0.5,
    opacity: 0.88,
  },

  fireball: {
    /** Segundos do E até a bola sair da mão (a preparação da arte é comprimida nisso). */
    castPre: 0.42,
    /** Segundos de recuperação depois da soltura. */
    castPost: 0.4,
    /** Depois da soltura, movimento ou novo E interrompem a recuperação após este tempo. */
    cancelAfter: 0.08,
    /** m/s */
    speed: 11,
    /** Metros até dissipar. */
    range: 10,
    /** Tamanho do projétil em relação à bola desenhada na arte de conjuração. */
    scale: 1.25,
    /** Tamanho da chama na mão em relação à bola da arte (igual ao projétil = sem salto na soltura). */
    heldScale: 1.25,
    flightFps: 16,
    heldFps: 14,
    fadeSeconds: 0.22,
    /** Explosão ao bater (6 frames ≈ 0,43 s). */
    impactFps: 14,
    /** Tamanho da explosão em relação à bola que bateu (1 = proporção da arte). */
    impactScale: 1,
  },

  level: {
    url: 'level/island.json',
    /** Some atrás de árvores, torii, rochas e penhascos. */
    occlusion: true,
    /** Folga (m) para o chão logo atrás dos pés não cortar o sprite. */
    occlusionBias: 0.3,
    showWalkable: false,
  },

  terrain: {
    /** Raio dos pés para colisão (m). */
    radius: 0.2,
    /** Maior desnível entre um passo e outro (m) — penhascos ficam acima disso. */
    maxStep: 0.3,
  },

  sea: {
    /** Metros por repetição da textura da água. */
    tile: 7,
    /** Neblina: começa e fecha em distâncias relativas à borda da ilha (1 = borda). */
    fogStart: 1.3,
    fogEnd: 1.9,
    /** Quanto a área de mar se estende para trás da ilha (topo da tela), × raio da frente. */
    fogBack: 2.2,
    fogColor: '#eef2f4',
  },

  audio: {
    /** Volume geral e por grupo (0–1). */
    volume: { master: 1, music: 1, ambience: 1, effects: 1, voice: 1 },
    muted: false,
    /**
     * Sonoridade-alvo de cada som, em LUFS (BS.1770). Os arquivos chegam com volumes muito
     * diferentes (o andar 21 dB abaixo do deslize, três deles passando de 0 dBFS); cada um é
     * medido ao carregar e recebe o ganho que o leva ao alvo, então o equilíbrio vem daqui.
     * Laços: sonoridade integrada. Efeitos e cada passo: pico em janela de 100 ms.
     * Hierarquia, acima da trilha + mar (≈ −24 LUFS juntos): explosão +13 LU, bola de fogo +12,
     * deslize +8, passo correndo +6, passo andando +3, farfalhar parada +1 (agudo, onde o mar
     * é fraco). `error`: aviso "só no computador" (toca sozinho, sem trilha por baixo; o
     * arquivo chega a −5 LUFS de pico, alto demais para alto-falante de celular).
     * `voice`: falas da apresentação (integrada), 11 LU acima da trilha abaixada por `duck`. Os
     * arquivos têm picos ~18 dB acima da sonoridade; mais alto, o limitador apertaria as plosivas.
     */
    levels: {
      impact: -11, fireball: -12, slide: -16, run: -18, walk: -21, idle: -23, music: -25, ambience: -28, error: -14,
      voice: -20,
    },
    /** Trilha e mar abaixados (dB) enquanto a apresentação está na tela. */
    duck: -6,
    /**
     * Fase da passada (0–1) em que cada pé toca o chão, medida na arte: o contato vem logo
     * depois do frame 0 do laço e se repete meio ciclo depois (erro ≲ 60 ms entre direções).
     */
    steps: { walk: [0.12, 0.62], run: [0.08, 0.58] },
    /** Variação aleatória por passo (sem efeito "metralhadora"): ± dB e ± fração da velocidade de reprodução. */
    stepJitter: { db: 1.5, rate: 0.05 },
    /** Crossfade (s) na emenda dos laços: a trilha termina cortada e o mar tem fade nas pontas. */
    crossfade: { music: 1.5, ambience: 3 },
    /** Farfalhar da roupa parada: s depois de parar, depois a cada [mín, máx] s. */
    idle: { first: 0.35, every: [8, 14] as [number, number] },
  },

  /** Apresentação inicial (ui/Welcome.ts). */
  welcome: {
    /** Velocidade do texto (letras/s). */
    charsPerSecond: 40,
    /** Pausa extra (s) depois de fim de frase (. ! ?) e de vírgula (, ; :). */
    pauseSentence: 0.3,
    pauseComma: 0.12,
  },

  debug: {
    timeScale: 1,
    showAnchor: false,
  },
};

export type Config = typeof config;
