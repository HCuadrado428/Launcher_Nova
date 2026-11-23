package net.novasmp.menu;

import com.mojang.realmsclient.RealmsMainScreen;
import java.util.ArrayList;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.OptionsScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.multiplayer.JoinMultiplayerScreen;
import net.minecraft.client.gui.screens.worldselection.SelectWorldScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.network.chat.Component;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.ScreenEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

/**
 * Deja el menú principal con tres botones: «Entrar al Nova 2», Opciones y
 * Salir. Un jugador, Multijugador, Realms y la lista de mods desaparecen, y
 * si algo intenta abrir esas pantallas (por ejemplo al desconectarse del
 * servidor) se vuelve al menú principal.
 *
 * El launcher puede pasar dos propiedades de Java:
 *   -Dnova.menuLibre=true   deja el menú normal de Minecraft (modpack admin)
 *   -Dnova.server=ip:puerto dirección del servidor
 */
@Mod.EventBusSubscriber(modid = NovaMenu.MOD_ID, value = Dist.CLIENT, bus = Mod.EventBusSubscriber.Bus.FORGE)
public final class MenuLock {
    private static final boolean MENU_LIBRE = Boolean.getBoolean("nova.menuLibre");
    private static final String SERVER = System.getProperty("nova.server", "xray.dathost.net:17487");

    private MenuLock() {
    }

    @SubscribeEvent
    public static void onTitleScreenInit(ScreenEvent.Init.Post event) {
        if (MENU_LIBRE || !(event.getScreen() instanceof TitleScreen)) {
            return;
        }
        Screen screen = event.getScreen();
        for (GuiEventListener listener : new ArrayList<>(event.getListenersList())) {
            if (listener instanceof AbstractWidget) {
                event.removeListener(listener);
            }
        }

        Minecraft minecraft = Minecraft.getInstance();
        int x = screen.width / 2 - 100;
        int y = screen.height / 4 + 48;
        event.addListener(Button.builder(Component.literal("Entrar al Nova 2"), button -> join(screen, minecraft))
                .bounds(x, y, 200, 20)
                .build());
        event.addListener(Button.builder(Component.translatable("menu.options"),
                        button -> minecraft.setScreen(new OptionsScreen(screen, minecraft.options)))
                .bounds(x, y + 24, 200, 20)
                .build());
        event.addListener(Button.builder(Component.translatable("menu.quit"), button -> minecraft.stop())
                .bounds(x, y + 48, 200, 20)
                .build());
    }

    @SubscribeEvent
    public static void onScreenOpening(ScreenEvent.Opening event) {
        if (MENU_LIBRE) {
            return;
        }
        Screen next = event.getNewScreen();
        if (next instanceof JoinMultiplayerScreen || next instanceof SelectWorldScreen || next instanceof RealmsMainScreen) {
            event.setNewScreen(new TitleScreen());
        }
    }

    private static void join(Screen parent, Minecraft minecraft) {
        ServerData server = new ServerData("NOVA 2", SERVER, false);
        ConnectScreen.startConnecting(parent, minecraft, ServerAddress.parseString(SERVER), server, false);
    }
}
