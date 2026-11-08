Notas da versão: V1.2.0-Alpha-V1

Principais mudanças

Esta é uma versão de prévia. Obrigado a quem instala e usa o plugin, e pela paciência a cada versão; relatos de bugs e sugestões são bem-vindos.

- Dez idiomas na interface, oito deles novos
- O plugin foi reestruturado e a inicialização a frio ficou bem mais rápida
- A janela destacada adapta-se ao tema e integra-se com o dsh-plugin-wallpaper-engine
- A lista nem sempre se atualizava ao excluir uma sessão; corrigido
- Sem runtime, agora o download é oferecido
- A pasta de dados pode voltar ao padrão
- Todos os diálogos usam os do DSH

As mudanças em detalhe

Novidades

- Oito idiomas novos, dez no total (japonês, coreano, alemão, francês, espanhol, russo, português, chinês tradicional)
- Barra de progresso dos resumos de IA
- Sem o componente Electron, o download é oferecido na hora
- Configurações › Pasta de dados: mudar de local e voltar ao padrão
- As notas da versão também são traduzidas
- «Janela destacada»: seguir o papel de parede do dsh-plugin-wallpaper-engine ou enviar uma imagem própria; desfoque, vidro fosco e escurecimento

Melhorias

- Início a frio 3,1 s → 0,12 s (duas mil sessões); reiniciar lê o manifesto de sessões
- Atualizar lê só os arquivos alterados; uma resposta não dispara mais uma varredura completa
- Listas longas criam apenas as linhas visíveis; a primeira tela economiza mais de cinquenta mil elementos
- Cabeçalho e estatísticas da sessão em cache por versão do arquivo
- A indexação libera a thread principal a cada 150 ms e limita o texto por sessão
- O destaque ao passar o mouse responde na hora
- Limpar cache agora inclui o manifesto de sessões, o conteúdo das sessões, o cache do Chromium e o índice
- Os diálogos usam os nativos do DSH
- Alguns textos revisados
- Os doze grupos da página de configurações estão ordenados por uso

Correções

- Excluir sessões: as abertas também vão para a lixeira, não caem em «Sem grupo» e não deixam pastas vazias
- O painel às vezes ficava em branco
- Uma sessão excluída continuava no espaço de trabalho
- A janela do explorador segurava o processo do DSH
- As margens do menu de linha não batiam com as do menu do host
- O runtime aparecia como Electron
- O progresso do download do componente agora começa no clique
- Um painel em 100 % não cobre mais a barra de título
- Os três botões no canto superior direito da janela destacada ficaram maiores
