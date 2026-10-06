# Documentação técnica

Como o Iso Miko funciona por dentro: pipelines que transformam a arte gerada por IA em assets jogáveis, física e animação da personagem, cenário, efeitos, som e interface. Para jogar ou rodar o projeto, veja o [README](../README.md).

- [Interface: HUD e painel de ajustes](#interface-hud-e-painel-de-ajustes)
- [Só no computador](#só-no-computador)
- [Apresentação inicial](#apresentação-inicial)
- [HUD de comandos](#hud-de-comandos)
- [Como a movimentação fica natural](#como-a-movimentação-fica-natural)
- [Cenário (ilha)](#cenário-ilha)
- [Bola de fogo](#bola-de-fogo)
- [Deslize](#deslize)
- [Som](#som)
- [Estrutura](#estrutura)
- [Regenerar sprites](#regenerar-sprites)
- [Limitações conhecidas da arte](#limitações-conhecidas-da-arte)

## Interface: HUD e painel de ajustes

O **HUD de comandos** é a arte das teclas montada peça por peça, e cada tecla reage quando é pressionada. Movimento (WASD) fica no canto inferior esquerdo; ações (Shift, E, C) e zoom no inferior direito. O centro, onde fica a personagem, e o topo ficam livres. Os dois conjuntos mantêm o espaçamento da arte e acompanham a largura da tela (teclas de ~48 px em 1280 px, ~70 px em 1920 px; `--hud-u` em `style.css`).

O painel de ajustes não aparece na tela do jogo. Em `npm run dev`, a tecla à esquerda do 1 mostra o painel e a leitura de estado (ação, direção, frame, terreno, fps). Pelo painel dá para calibrar velocidade/passada/giro, desacelerar o tempo, ver âncora e célula do sprite, ajustar som e efeitos e rodar um **demo automático** (círculo, rosa dos ventos, bola de fogo e deslize nas 8 direções) para validar sem teclado.

## Só no computador

O jogo precisa de teclado e da roda do mouse. Em celular e tablet (`src/ui/DesktopOnly.ts`), ele nem carrega: aparece um aviso no pergaminho do HUD explicando a limitação.

- **Detecção**: o navegador se declara móvel (user agent / `userAgentData.mobile`), ou o ponteiro principal é o dedo (`pointer: coarse` sem `hover`). O iPad se apresenta como Mac e é pego pelo toque. Notebook com tela de toque passa, porque o ponteiro principal é o touchpad/mouse.
- **X (fecha a página)**: o navegador só deixa um script fechar a aba aberta por script ou com uma única página no histórico, como um link aberto direto. Nos outros casos, o X volta para a página de onde a pessoa veio; sem página anterior, esvazia a aba. No Chrome emulado, o X fechou a aba aberta direto e voltou para a anterior quando havia histórico.
- **Som de erro** (`public/audio/error.mp3`): toca junto com o aviso, a partir do tom (o arquivo começa com um clique e meio segundo de silêncio), normalizado para `config.audio.levels.error`, porque o original chega a −5 LUFS de pico. Celulares bloqueiam som antes de um toque: se o navegador bloquear, ele toca no primeiro toque na tela (menos no X). É tocado pela Web Audio porque o Safari do iPhone ignora o volume de `<audio>`.
- **Texto**: fonte [Fredoka](https://fonts.google.com/specimen/Fredoka) (SIL OFL, `public/fonts/OFL.txt`). Foi comparada lado a lado com as letras das teclas da arte e escolhida entre Baloo 2, Nunito, M PLUS Rounded, Varela Round e outras, pelo mesmo peso, o "A" de topo arredondado e o "W" largo. Fica hospedada no projeto (subconjunto latino, cobre os acentos do português).
- **Pergaminho e X**: vêm de `assets-src/hud/dialog.png`, separados por `npm run hud`, que também mede a moldura interna do pergaminho; o texto vai dentro dela. Os tamanhos estão em `cqw` (fração da largura do pergaminho) e acompanham qualquer tela, em pé ou deitada.

**Sem "Salvar imagem"** (PC e celular): o menu de contexto é cancelado (botão direito, tecla de menu, toque longo no Android) e imagens e canvas não podem ser arrastados (`main.ts`). No iPhone, o balão de segurar o dedo sai pelo `-webkit-touch-callout: none` (`style.css`). Isso só afasta o salvamento casual: os arquivos em `public/` continuam acessíveis pelas ferramentas do navegador ou pelo endereço direto.

## Apresentação inicial

Na primeira visita, depois que a ilha carrega, a Iso Miko se apresenta em 4 falas (`src/ui/Welcome.ts`, arte e textos em `assets-src/welcome/`): retrato à esquerda, caixa de pergaminho embaixo, voz e texto escrito letra a letra. A ilha continua visível por trás. O jogo fica travado: a personagem não se move, o HUD some e a trilha e o mar abaixam 6 dB (`config.audio.duck`).

- **Convite**: começa com "Clique ou aperte Espaço para começar". O navegador só libera som depois de um gesto, e o mesmo gesto já inicia a 1ª fala com voz.
- **Avançar**: clique, Espaço, Enter ou →. Com o texto ainda sendo escrito, completa o texto; com ele completo, vai para a próxima fala (cortando a voz). A seta ">>>" da caixa só aparece, indo e voltando, quando dá para avançar.
- **Cada fala** troca o retrato (crossfade com um pulinho) e toca `public/audio/welcome-N.mp3` a partir do começo da voz, normalizada para `config.audio.levels.voice` (sonoridade integrada). Velocidade do texto e pausas na pontuação em `config.welcome`. Com "reduzir movimento", o texto aparece inteiro e sem animações.
- **Fim**: ao avançar na última fala, o jogo é liberado e o HUD volta. A voz final termina por cima do jogo, e a trilha só volta ao volume normal quando ela acaba.
- **Não repete**: só ao passar pela última fala fica gravado `iso-miko:welcome:v1` no `localStorage`. Atualizar a página no meio recomeça do convite. Para rever: abra com `?apresentacao` no endereço (não apaga o registro) ou apague a chave. Mudar a versão da chave faz a apresentação voltar para todo mundo. Sem `localStorage` (bloqueado pelo navegador), ela aparece a cada visita.

**Pipeline** (`npm run welcome`, `tools/build-welcome.ts`):

- **Retratos** (`portrait-1..4.png`, fundo verde): chroma key e um recorte só para os quatro (a união das silhuetas). Cabeça e corpo estão no mesmo lugar em todos, então a troca não salta. A arte termina na cintura; essa borda fica atrás da caixa.
- **Caixa** (`dialog.png`): o papel da fala e o miolo da aba do nome são medidos a partir de um ponto dentro de cada um (`SEEDS`), até a primeira faixa mais escura que o papel.
- **Seta ">>>"**: separada da caixa pelos componentes que destoam do papel e não tocam a borda da área de busca (o canto arredondado da moldura encosta nela). A transparência vem da distância até a cor do papel. No lugar da seta, o papel é refeito coluna a coluna.
- `--debug` grava `.sprite-debug/welcome_box.png` com as áreas medidas.

## HUD de comandos

Fonte: `assets-src/hud/controls.png` (arte única, fundo verde). `npm run hud` (`tools/build-hud.ts`) gera uma imagem por peça em `public/hud/`, com a posição de cada uma na arte. Assim o jogo anima a tecla, a seta ou o ícone e os raios de brilho separadamente:

- **Peças**: componentes conexos depois de uma erosão de 2 px, que desfaz as pontes finas entre um raio e a tecla. Raios encostados com junção larga saem pela cor: um trecho amarelo que toca o fundo é raio, já que o dourado e o creme da tecla ficam dentro do contorno escuro. Cada peça grande recebe o nome da semente mais próxima (`SEEDS`).
- **Tecla × seta/ícone** (estão grudados na arte): a tecla é um trapézio (o topo tem ~75% da base), então largura sozinha não separa. O corte parte do corpo da tecla (linhas cobertas de lado a lado), atravessa o chanfro claro e para no fim da borda escura. O rastro do C tem um contorno escuro grosso e largo, mas separado da tecla por um vão.
- **Raios**: vão para a tecla mais próxima. Os do meio, entre A–S e S–D, ficam à mesma distância das duas teclas e estão declarados como do S (`RAY_ZONES`).
- `--debug` grava `.sprite-debug/hud_parts.png` com cada peça numa cor.

**Efeitos** (`src/style.css`, classes postas por `src/ui/Hud.ts`; W/A/S/D e as setas do teclado acionam o mesmo grupo):

| Tecla | Segurada | A cada toque |
| --- | --- | --- |
| todas | afunda, clareia e brilha; raios acendem | raios estouram para fora |
| W A S D | a seta sai na direção da tecla e pulsa | — |
| Shift | o bonequinho corre (avança, inclina e quica) | — |
| E | — | a bola de fogo encolhe, explode em chamas e volta |
| C | brilho azul no ícone | o boneco desliza para a frente e volta |
| roda | o sinal do zoom (+/−) cresce e a seta curva gira | — |

Em repouso os raios ficam a 60% de opacidade, para acender quando a tecla é pressionada. Com "reduzir movimento" ativado no sistema, as animações são desligadas.

## Como a movimentação fica natural

**No pipeline de sprites** (`tools/build-sprites.ts`), as sheets geradas por IA chegam com defeitos que o jogo não corrigiria:

- **Escala que varia por linha da sheet** (até 8%) e entre direções → cada linha é normalizada pela mediana da altura; todas as direções da ação ficam com a mesma altura. Sem isso a personagem "pulsa" a cada ciclo e muda de tamanho ao virar.
- **Tremido lateral** → o tronco de cada frame é registrado (correlação de silhueta) contra a média da direção.
- **Alinhamento vertical por ação** → no andar, o pé mais baixo fica na linha do chão (sempre há um pé apoiado). Na corrida (`vertical: 'torso'`), cabeça e tronco são registrados entre si e o chão fica no nível dos frames de contato. Na fase de voo os dois pés estão no ar, e alinhar pelo pé faria o corpo afundar justamente quando deveria subir, o que parece um quique. O log mostra a variação da cabeça por direção e avisa `⚠ cabeça pulando`.
- **Ciclo** → o período do passo é medido pela autocorrelação da região das pernas (9 frames → ciclo de 18). O laço é recortado onde o último frame mais se parece com o primeiro e **rotacionado para começar na pose de passagem**, então a fase é comum a todas as direções e às duas ações.
- **Parada (idle)** → uma pose por direção (`assets-src/character/idle/`). A arte veio desenhada ~3× maior que as outras sheets, então cada direção é **dimensionada pela altura da pose de passagem do andar** (`matchHeight`), que é o frame de onde ela para. Assim não há salto de tamanho ao parar nem ao voltar a andar. No jogo, uma respiração sutil (±0,6% na vertical, ancorada nos pés) evita a pose congelada; ajuste ou desligue em `config.idle`.
- **Direções com defeito** → em `walk/sw` e `walk/nw` a IA girou o corpo na 3ª linha da sheet. Essas direções são geradas pelo espelho de `se`/`ne` (configurável em `CHARACTERS[].actions[].mirror`).
- **Passada** → estimada pela abertura dos pés nas vistas laterais (m por ciclo).

**No jogo** (`src/character/Locomotion.ts`):

- A animação é **dirigida por distância** (fase += distância / passada): a cadência acompanha a velocidade, inclusive acelerando e freando, e os pés não patinam.
- O facing **gira com velocidade angular finita**: uma inversão passa pelas direções intermediárias (de frente para a câmera) em vez de estalar.
- A velocidade **segue o facing**: ela nunca anda de lado ou de costas em relação ao sprite e freia enquanto vira.
- Ao soltar as teclas, ela **termina o passo** até a próxima pose de passagem antes do idle.
- Ao soltar uma diagonal, há **90 ms de tolerância** para a 2ª tecla, o que evita virar para N/S/L/O no último frame.
- Andar↔correr troca no meio do caminho entre as velocidades (com histerese), mantendo a fase.

## Cenário (ilha)

Fonte: `assets-src/level/island.png` (pintura isométrica, fundo verde) e `water.png` (água contínua). A interpretação da pintura está em `tools/level/island.level.ts`, em coordenadas da imagem original.

**Pipeline** (`npm run level`, `tools/build-level.ts`):

1. **Ampliação 4× com Real-ESRGAN** (rede neural, roda na GPU via Vulkan). Leva a ilha a 4720×3528 px, o que dá ~1 texel por pixel de tela no zoom padrão. O executável não vai no repositório: baixe o [realesrgan-ncnn-vulkan](https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0) para Windows e extraia em `.tools/esrgan/`. Sem ele, o pipeline usa Lanczos (com aviso). O resultado fica em cache em `.cache/level/`.
2. **Recorte do fundo**: o verde puro sai e, perto da borda, misturas com o verde são desmisturadas. Os bolsões entre folhas, que a IA sombreou, saem pela matiz. A água pintada se dissolve no mar procedural.
3. **Material por pixel** (`tools/level/material.ts`): areia, grama e pétalas são pisáveis. Rocha, folhagem, tronco, torii e água são barreira. Pedras e plantas menores que ~0,6 m não bloqueiam.
4. **Terraços com altura**: praia 0,3 m → degraus de pedra (3 degraus) → caminho e platô direito 1,2 m → escadaria (5 degraus de 0,35 m) → platô do torii 2,95 m. Cada terraço é convertido da imagem para o chão com a sua altura, então os pés caem exatamente sobre a área pintada. Penhascos são desníveis entre terraços: não dá para atravessar.
5. **Profundidade por pixel** (`public/level/depth.png`): cada pixel guarda a profundidade do chão a que pertence e um nível. Árvores e torii são "cartões" com base própria. Rochas e faces de penhasco herdam a base logo abaixo. Personagem, sombra, poeira e bola de fogo somem atrás do que estiver na frente.
6. **Grade do chão** (0,1 m): altura, região e distância até a barreira mais próxima. A borda da área caminhável é suavizada (filtro de maioria), para o serrilhado da classificação por pixel não virar "dente" na parede. Desníveis entre células vizinhas também viram parede.
7. **Furinhos** fechados de até ~12 px da pintura original (fundo verde que sobrou na rocha e nas copas) são preenchidos com a cor vizinha. Os vãos maiores (atrás do rio, entre galhos e vigas) mostram o mar, que continua por trás da ilha; a neblina só fecha além dele.

**No jogo**:
- **Colisão**: em subpassos de 4 cm. Encostando na parede, ela é empurrada para fora pela normal do campo de distância e escorrega rente à parede, sem perder velocidade. Só para de frente para a parede ou num canto.
- **Escadas**: a altura exibida segue a posição. Os pés ficam no plano de cada degrau e sobem o espelho na faixa central entre dois degraus, sem estalo e igual na ida e na volta. A velocidade cai um pouco.
- **Torii e árvores**: a máscara dos pilares foi medida nos pixels vermelhos da pintura. As vigas entram só pelos pixels vermelhos e escuros, e as árvores só com o que está ligado ao tronco.
- **Água**: só ciano bem saturado é água. A pedra azul-acinzentada e os brilhos claros soltos são pedra, então não recebem o efeito de água. A ondulação só desloca pixels de água para dentro de água. Contra uma parede ela para na pose parada. A bola de fogo bate (e explode) em penhascos, rochas e troncos à frente dela e passa por cima do que está abaixo. O mar tem duas camadas animadas. A neblina branca, em bancos animados, fecha o horizonte numa elipse bem maior que a ilha e mais funda para trás, então o topo da tela fica todo de mar. Ajuste em `config.sea` ou no painel de desenvolvimento ("mar atrás da ilha", "mar: neblina fecha"). Ajustes na pasta **Cenário** do painel, incluindo "mostrar área caminhável".

Para ajustar barreiras: edite polígonos e alturas em `tools/level/island.level.ts` e rode `npm run level -- --debug`. Medição da física junto às paredes (teste automático no navegador, 672 trajetos perto das escadas): 4% de enroscos, todos em cantos côncavos; 101% da velocidade ao escorregar; nenhum salto de altura nos degraus. As sobreposições em `.sprite-debug/level_*.png` mostram caminhável (verde) e barreira (vermelho), material, profundidade e a grade do chão.

Áreas não alcançáveis: o platô esquerdo (do pinheiro) fica isolado pelo rio e pelos penhascos; a encosta gramada ao lado da escadaria e o alto das rochas são decorativos.

## Bola de fogo

- **Conjuração** (`assets-src/character/cast/`): a bola desenhada na arte é **apagada** pelo pipeline, que registra posição e tamanho por frame (`fire` no manifest) e o frame em que ela sai da mão (`release`). No jogo, a chama da sua sheet é desenhada nesse ponto durante a carga, e o projétil nasce exatamente onde a arte solta a bola.
- **Projétil** (`assets-src/fx/fireball.png`): o pipeline detecta sozinho a linha que voa para a direita e a linha da chama "segurada" (labaredas para cima), alinhando cada frame pelo núcleo branco. Em voo o sprite é **girado no plano da tela** para a direção real do disparo, então qualquer ângulo, inclusive as diagonais 2:1, fica coerente. No fim do alcance ele toca os frames de dissipação.
- **Explosão** (`assets-src/fx/explosion.png`, `tools/sprites/explosion.ts`, `src/fx/Explosions.ts`): se a bola bate em algo antes do fim do alcance, ela some e explode ali.
  - **A sheet**: cada linha é a bola chegando (2 frames) e explodindo (6). O pipeline mede o rumo de cada linha na bola (cauda → núcleo) e põe no atlas, para cada uma das 8 direções, a linha ou o espelho mais próximo (erro ≤ 6°). A sheet tem duas linhas para SE e nenhuma para SO, que sai do espelho da SE.
  - **Âncora e tamanho**: os frames são ancorados no núcleo branco, que fica a distância quase constante da base, então a explosão fica plantada na superfície. A bola desenhada na sheet serve de régua: a explosão tem a proporção da arte em relação à bola do jogo.
  - **Despill**: faíscas misturadas com o fundo verde ficavam oliva; nos tons amarelados, o verde fica limitado a 92% do vermelho.
  - **Ponto de contato**: o teste de colisão só pega a bola já dentro da superfície (anda ~18 cm por frame), então o contato é refinado por bissecção no último passo.
  - **Oclusão**: a colisão acontece quando a bola passa para trás da silhueta de algo mais alto, e a base dessa rocha pode estar metros mais perto da câmera. A explosão usa a chave do obstáculo mais à frente na área que ocupa (`Level.frontKey`): aparece inteira sobre a pedra atingida e continua atrás de copas e troncos.
  - Clarão aditivo e luz no chão somem com ela. Ajustes no painel: "explosão: tamanho" e "explosão: quadros/s".
- **Controle**: E trava o movimento. Depois da soltura, andar ou apertar E de novo interrompem a recuperação. Um E apertado durante a carga entra na fila.
- Ajustes em `config.fireball` ou no painel (tempo até soltar, recuperação, velocidade, alcance, tamanho).

Limitações da arte de conjuração (sheets em `cast/_nao-usadas/`):

| Direção | Origem |
| --- | --- |
| N, NE, E, SE, NO | sheets próprias (N arremessa para cima à esquerda) |
| SO | espelho de SE. A sheet própria troca de orientação no meio e arremessa para o lado oposto |
| O | espelho de E. A sheet própria vira de costas nos frames 5–9 |
| S | **não existe**. Conjura para SE ou SO conforme o último lado pressionado |

## Deslize

- **Arte** (`assets-src/character/slide/`): 18 frames por direção: corrida (0–2), chão (3–10) e subida já correndo (11–17). Deitada, a personagem encosta no frame vizinho, então a sheet é segmentada por **grade fixa**: o corte fica no vale entre colunas e cada parte conexa vai inteira para o frame que contém a maior parte dela.
- **Escala**: medida no frame em pé de cada linha da sheet e ajustada à corrida, para não mudar de tamanho ao entrar.
- **Âncora**: no **centro de massa** da silhueta (o quadril no corpo deitado), o ponto que desliza de forma contínua. No 1º e no último frame ela coincide com o tronco, como na corrida. Nas diagonais o chão sob o corpo é inclinado na tela, então a altura da âncora segue essa inclinação.
- **Fases e sincronia**: o pipeline detecta contato e subida pela altura da silhueta e compara poses com a corrida:
  - entrada: para cada posição da passada, quantos frames esperar (no máximo 2, ~70 ms) e em qual frame do deslize entrar, para o pé encaixar;
  - saída correndo: em que frame do deslize sair e em que fase da corrida continuar;
  - saída parada: o primeiro frame em pé da subida.
- **Física** (`src/character/Slide.ts`):
  - impulso no contato (1,3× a corrida);
  - no chão, atrito constante, com queda linear até 30%;
  - quase para ao levantar;
  - retoma a corrida se a direção estiver pressionada; sem direção, fica em pé.
- **Efeitos**: a sombra se alonga na direção do movimento quando o corpo está deitado. A poeira (`assets-src/fx/dust.png`) tem uma linha da sheet por direção, mais um estouro de impacto no contato. As nuvens ficam presas ao chão e formam o rastro.

Limitações da arte do deslize: só **SE, O e NO** mantêm o estilo "deitada, pés à frente" do começo ao fim.

| Direção | Origem | Defeito da sheet própria |
| --- | --- | --- |
| SE, O, NO | sheets próprias | — |
| SO | espelho de SE | avanço agachado |
| L | espelho de O | fica de frente, ajoelhada |
| NE | espelho de NO | desliza de joelhos |
| N, S | usam NE/NO e SE/SO conforme o último lado | N de joelhos; S vira de perfil |

Em N e S o corpo aparece de lado (natural num deslize), mas o movimento segue reto.

## Som

Arquivos em `public/audio/`. O som começa no primeiro toque de tecla ou clique: antes disso o navegador bloqueia áudio. `Esc` não conta como gesto para o navegador; nesse caso o som é liberado no gesto seguinte. A trilha e o mar entram com fade de ~1 s.

| Arquivo | Quando toca |
| --- | --- |
| `walk.mp3`, `run.mp3` | um passo cada vez que a fase da passada cruza o contato de um pé |
| `slide.mp3` | no início do deslize, agendado para o impacto do arquivo cair no frame em que o corpo toca o chão |
| `fireball.mp3` | na soltura da bola, a partir do ataque do arquivo; cortado com fade se a bola explodir |
| `fireball-impact.mp3` | na explosão, a partir do ataque, na panorâmica em que o sopro estava; no máximo 3 ao mesmo tempo (o crepitar dura ~2,5 s) |
| `idle.mp3` | farfalhar da roupa 0,35 s depois de parar e, parada, a cada 8–14 s |
| `music.mp3`, `ambience.mp3` | em laço, por baixo de tudo |
| `welcome-1.mp3` … `welcome-4.mp3` | falas da apresentação inicial (só carregadas quando ela aparece) |

**Equilíbrio** (`src/audio/analysis.ts`): os arquivos chegam com volumes muito diferentes. O andar fica 21 dB abaixo do deslize, e três arquivos passam de 0 dBFS. Cada um é medido ao carregar (sonoridade BS.1770, a mesma da referência pyloudnorm, ±0,1 dB) e recebe o ganho que o leva ao alvo em `config.audio.levels`:

- laços: sonoridade integrada;
- efeitos e cada passo: pico em janela de 100 ms, o tempo em que o ouvido soma um som curto.

Acima da trilha + mar (≈ −24 LUFS juntos), os alvos dão: explosão +13 LU (o crepitar depois dela, +2), bola de fogo +12, deslize +8, passo correndo +6, passo andando +3. O farfalhar fica em +1, mas é agudo (6–8 kHz), onde o mar é fraco, e fica 11 dB acima dele nessa faixa. Na saída há um limitador de segurança que só age quando vários sons fortes se somam. No painel de desenvolvimento (tecla `'`), a pasta **Som** tem volume geral, música, mar e efeitos, e em **Mixagem** fica o alvo de cada som.

**Passos**:
- Os arquivos de passos são fatiados sozinhos: cada passo é o pico mais forte num raio de 180 ms, então o toque da ponta do pé fica dentro dele. São 2 passos no andar e 6 na corrida, cada um normalizado.
- O jogo sorteia a fatia (nunca a mesma duas vezes seguidas) com ±1,5 dB e ±5% de tom.
- Como a fase avança pela distância, os passos seguem a cadência e o fim do passo ao parar (mais leves). Somem ao empurrar uma parede.
- O contato está em `config.audio.steps`. Foi medido na arte pela abertura máxima dos pés e varia ~±0,06 ciclo entre direções (≲ 60 ms).
- O disparo é adiantado pela latência de saída do navegador.

**Laços**: a trilha termina cortada (estalaria) e o mar tem fade nas pontas (afundaria). Cada volta toca só o trecho com som e a seguinte entra com crossfade de potência constante (1,5 s na trilha, 3 s no mar).

**Bola de fogo e deslize**:
- A panorâmica acompanha o voo da bola: atirando para a direita, o som vai para a direita.
- Se o deslize bate numa parede, o arrasto some junto com a velocidade.
- Medido no Chrome: o impacto do deslize cai a 2–18 ms do frame de contato. No 1º deslize da sessão, o envio do atlas para a GPU trava alguns frames e o visual atrasa ~0,1 s em relação ao som.

## Estrutura

```
assets-src/character/<ação>/<dir>.webp   sheets originais (dir: n ne e se s sw w nw; ação: walk, run, cast)
assets-src/fx/fireball.png               sheet do projétil
assets-src/fx/explosion.png              sheet da explosão ao bater
assets-src/hud/controls.png              arte do HUD de comandos
assets-src/hud/dialog.png                pergaminho + botão X (aviso "só no computador")
assets-src/welcome/                      apresentação: retratos, caixa de diálogo e falas.txt
tools/build-welcome.ts                   apresentação: retratos recortados, caixa sem a seta + seta, áreas de texto
tools/build-hud.ts                       HUD: peças separadas (tecla, seta/ícone, raios) + posições
docs/                                    esta documentação + imagens do README e artes de divulgação (docs/media/)
.github/workflows/deploy.yml             build e publicação no GitHub Pages a cada push na main
tools/build-sprites.ts                   configuração das ações + orquestração do pipeline
tools/sprites/                           image (key, componentes), segment (projeção e grade), align, cycle, fire,
                                         slide (escala/âncora/fases/sincronia), projectile, dust, explosion, debug
assets-src/level/                        island.png (pintura) + water.png (água contínua)
tools/build-level.ts + tools/level/      pipeline do cenário + interpretação da pintura (island.level.ts)
src/
  config.ts                 parâmetros (escala, câmera, ciclos, aceleração, giro)
  Game.ts                   loop, cena, ligação entre módulos
  core/IsoCamera.ts         câmera ortográfica dimétrica 2:1 (30°/45°) que segue o alvo
  core/Input.ts             teclado por event.code (funciona em ABNT2)
  core/Demo.ts              input automático para validação
  character/Locomotion.ts   estado, giro, velocidade, fase (sem three.js)
  character/Cast.ts         tempo da conjuração e evento de soltura (sem three.js)
  character/Slide.ts        fases, velocidade e saídas do deslize (sem three.js)
  character/Character.ts    billboard ancorado nos pés + sombra + chama na mão; escolhe frame
  fx/FxAtlas.ts             atlas do efeito + textura de brilho
  fx/Fireballs.ts           projéteis: voo girado na tela, brilho, luz no chão, dissipação, contato
  fx/Explosions.ts          explosão ao bater: linha da direção, clarão, luz no chão
  fx/Dust.ts                poeira do deslize presa ao chão
  character/directions.ts   8 direções e ângulos
  sprites/SpriteAtlas.ts    carrega manifest/atlas, UV por frame
  sprites/SpriteMaterial.ts shader do sprite (alfa pré-multiplicado)
  level/Level.ts            grade do chão: altura, colisão com deslize, degraus, profundidade
  level/Island.ts           pintura ampliada em blocos, água pintada animada, cascata
  level/occlusion.ts        oclusão por pixel compartilhada pelos sprites
  world/Sea.ts              mar procedural + neblina
  ui/Hud.ts                 HUD de comandos (peças da arte, teclas reagindo) + leitura de estado (dev)
  ui/DebugPanel.ts          painel de ajustes (só em dev, tecla ')
  ui/DesktopOnly.ts         detecção de computador + aviso para celular/tablet (X fecha a página)
  ui/Welcome.ts             apresentação inicial (falas, voz, texto letra a letra, registro de que foi vista)
  audio/analysis.ts         sonoridade BS.1770, ataque, trecho com som, fatiamento de passos (sem Web Audio)
  audio/Mixer.ts            grupos, limitador, sons avulsos, laço com crossfade, desbloqueio no 1º gesto
  audio/GameAudio.ts        quando cada som toca (passos, parada, deslize, bola de fogo, laços)
public/audio/               sons (mp3)
```

Atlas: uma textura por ação, com uma linha por direção (ordem `n ne e se s sw w nw`, ou duas se não couber em 4096px) e uma coluna por frame da sheet. O manifest guarda, por direção, os índices de célula na ordem de reprodução.

## Regenerar sprites

```bash
npm run sprites            # gera public/sprites/character/
node tools/build-sprites.ts --debug   # + pré-visualizações em .sprite-debug/
```

Arquivos de depuração (`.sprite-debug/`):

- `*_strip.png`: todos os frames alinhados, com a âncora (vertical) e a linha do chão. Barra azul = no laço, laranja = idle.
- `*_onion.png`: sobreposição do laço. Tronco nítido significa alinhamento bom.
- `*_feet.png` (vistas E/W): pernas deslocadas pela distância percorrida. Se o pé de apoio fica na mesma coluna em linhas seguidas, não há patinação. Se não fica, ajuste a passada no painel.
- `cast_*_strip.png`: círculo ciano = bola na mão, magenta = bola solta; barra laranja = frame de soltura.
- `fx_fireball.png`: atlas do projétil (linha de voo e linha da chama segurada).
- `fx_explosion.png`: atlas da explosão (uma linha por direção, na ordem L, NE, N, NO, O, SO, S, SE).

Para uma ação nova: coloque as sheets em `assets-src/character/<ação>/<dir>.webp`, adicione a ação em `CHARACTERS` (em `tools/build-sprites.ts`) e rode `npm run sprites`. Direções sem arte boa podem usar `mirror` (espelho de outra) ou `alias` (reusa outra).

## Limitações conhecidas da arte

- Algumas sheets têm um dos dois passos desenhado mais curto. Com uma passada única, há uma leve patinação nesse passo (visível em `walk_e_feet.png`).
- O idle é uma pose estática por direção (sem animação desenhada). A respiração é procedural.
- `run/s` (correr de frente): a arte desenha as mãos em posições quase aleatórias de um frame para o outro. O pipeline usa só os 12 frames com o movimento de mão mais contínuo (`subset`), o que reduz o salto médio das mãos em ~18%, mas não o elimina. A correção definitiva é gerar essa sheet de novo.
- `walk/sw` e `walk/nw` são espelhos de `se`/`ne`. Se a IA gerar versões consistentes, basta remover o `mirror` e rodar o pipeline.

